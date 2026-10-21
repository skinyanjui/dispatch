import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError, digest } from "./auth";
import { loadDocumentSlots } from "./documents";
import { exceptionOwners, loadExceptions } from "./exceptions";
import { suggestExceptions } from "./exception-rules";
import { enqueueForUser } from "./notifications";
const timezone = z.string().refine((s) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");
const stop = z
  .object({
    kind: z.enum(["pickup", "delivery"]),
    address: z.string().trim().min(3).max(500),
    timezone,
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
  })
  .refine(
    (s) => Date.parse(s.windowEnd) >= Date.parse(s.windowStart),
    "Invalid appointment window",
  );
export const createSchema = z
  .object({
    carrierId: z.uuid(),
    reference: z.string().trim().min(1).max(100),
    source: z.string().trim().min(1).max(100),
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    stops: z.array(stop).min(2).max(10),
  })
  .refine(
    (s) =>
      // Refinements still run after a count error; guard before indexing.
      s.stops.length >= 2 &&
      s.stops[0].kind === "pickup" &&
      s.stops[s.stops.length - 1].kind === "delivery" &&
      s.stops.every(
        (stop, i) =>
          i === 0 ||
          Date.parse(stop.windowStart) >= Date.parse(s.stops[i - 1].windowEnd),
      ),
    "Stops start with a pickup, end with a delivery and run in time order",
  );
export async function auditDenied(user: string, resource: string) {
  await pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    "access.denied",
    resource,
  ]);
}
export async function member(
  c: PoolClient,
  user: string,
  carrier: string,
  write = false,
) {
  const { rows } = await c.query(
    "SELECT role,driver_id FROM memberships WHERE user_id=$1 AND carrier_id=$2",
    [user, carrier],
  );
  if (!rows[0] || (write && rows[0].role === "driver"))
    throw new HttpError(404, "NOT_FOUND");
  return rows[0];
}
export async function scoped(
  c: PoolClient,
  user: string,
  id: string,
  write = false,
  allowDriverWrite = false,
) {
  const { rows } = await c.query(
    `SELECT l.* FROM loads l
    JOIN memberships m ON m.carrier_id=l.carrier_id AND m.user_id=$2
    WHERE l.id=$1 AND ($3::boolean=false OR m.role<>'driver' OR $4::boolean)
      AND (m.role<>'driver' OR EXISTS(SELECT 1 FROM load_assignments a WHERE a.load_id=l.id AND a.driver_id=m.driver_id))
    ${write ? "FOR UPDATE OF l" : ""}`,
    [id, user, write, allowDriverWrite],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0];
}
export async function event(
  c: PoolClient,
  user: string,
  load: { id: string; carrier_id: string },
  type: string,
  payload: unknown,
) {
  const id = randomUUID();
  await c.query(
    "INSERT INTO load_events(id,load_id,carrier_id,actor_id,type,payload) VALUES($1,$2,$3,$4,$5,$6)",
    [id, load.id, load.carrier_id, user, type, JSON.stringify(payload)],
  );
  await c.query(
    "INSERT INTO outbox_events(id,event_id,payload) VALUES($1,$2,$3)",
    [randomUUID(), id, JSON.stringify({ loadId: load.id, type })],
  );
  await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    type,
    load.id,
  ]);
}
export async function requireAgreement(c: PoolClient, carrierId: string) {
  const auth = await c.query(
    "SELECT 1 FROM carrier_dispatch_authorizations WHERE carrier_id=$1 AND verified_at<=now() AND effective_at<=now() AND expires_at>now() FOR SHARE",
    [carrierId],
  );
  if (!auth.rowCount)
    throw new HttpError(422, "CARRIER_AUTHORIZATION_REQUIRED");
}
export async function createLoad(user: string, input: unknown, key: string) {
  const data = createSchema.parse(input);
  if (!key || key.length > 128)
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
  return transaction(async (c) => {
    await member(c, user, data.carrierId, true);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + key,
    ]);
    const hash = digest(JSON.stringify(data));
    const old = await c.query(
      "SELECT * FROM idempotency_keys WHERE user_id=$1 AND key=$2",
      [user, key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return (
        await c.query("SELECT * FROM loads WHERE id=$1", [old.rows[0].load_id])
      ).rows[0];
    }
    await requireAgreement(c, data.carrierId);
    const id = randomUUID();
    const result = await c.query(
      "INSERT INTO loads(id,carrier_id,reference,source,amount_minor) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [id, data.carrierId, data.reference, data.source, data.amountMinor],
    );
    for (const [i, s] of data.stops.entries())
      await c.query("INSERT INTO load_stops VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [
        randomUUID(),
        id,
        i + 1,
        s.kind,
        s.address,
        s.timezone,
        s.windowStart,
        s.windowEnd,
      ]);
    await c.query("INSERT INTO idempotency_keys VALUES($1,$2,$3,$4)", [
      user,
      key,
      hash,
      id,
    ]);
    await event(c, user, result.rows[0], "load.created", data);
    return result.rows[0];
  });
}
export async function listLoads(user: string, params: URLSearchParams) {
  const limit = 25;
  const raw = params.get("cursor");
  let cursor: { at: string; id: string } | null = null;
  if (raw) {
    if (raw.length > 200) throw new HttpError(400, "INVALID_CURSOR");
    try {
      cursor = z
        .object({
          at: z
            .string()
            .max(50)
            .regex(
              /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-](?:0\d|1[0-5])(:[0-5]\d)?$/,
            )
            .refine((value) => {
              // PostgreSQL text timestamps include a space and may omit offset
              // minutes. Check actual calendar validity before a database cast.
              const iso = value
                .replace(" ", "T")
                .replace(/([+-]\d{2})$/, "$1:00");
              return (
                Number(value.slice(0, 4)) > 0 &&
                z.iso.datetime({ offset: true }).safeParse(iso).success
              );
            }),
          id: z.uuid(),
        })
        .parse(JSON.parse(Buffer.from(raw, "base64url").toString()));
    } catch {
      throw new HttpError(400, "INVALID_CURSOR");
    }
  }
  const filters = z
    .object({
      carrier_id: z.uuid().optional(),
      status: z
        .enum(["booked", "dispatched", "picked-up", "delivered"])
        .optional(),
      q: z.string().max(100).optional(),
    })
    .parse({
      carrier_id: params.get("carrier_id") ?? undefined,
      status: params.get("status") ?? undefined,
      q: params.get("q") ?? undefined,
    });
  const { rows } = await pool.query(
    `SELECT l.*,l.created_at::text cursor_at,c.name carrier_name,(SELECT address FROM load_stops WHERE load_id=l.id AND sequence=1) pickup,(SELECT address FROM load_stops WHERE load_id=l.id ORDER BY sequence DESC LIMIT 1) delivery,(SELECT count(*)::int FROM load_stops WHERE load_id=l.id) stop_count FROM loads l JOIN carriers c ON c.id=l.carrier_id JOIN memberships m ON m.carrier_id=l.carrier_id AND m.user_id=$1 LEFT JOIN load_assignments a ON a.load_id=l.id WHERE (m.role<>'driver' OR a.driver_id=m.driver_id) AND ($2::text IS NULL OR l.carrier_id::text=$2) AND ($3::text IS NULL OR l.stage=$3) AND ($4::text IS NULL OR l.reference ILIKE '%'||$4||'%') AND ($6::timestamptz IS NULL OR l.created_at<$6 OR (l.created_at=$6 AND l.id>$7::uuid)) ORDER BY l.created_at DESC,l.id LIMIT $5`,
    [
      user,
      filters.carrier_id ?? null,
      filters.status ?? null,
      filters.q ?? null,
      limit + 1,
      cursor?.at ?? null,
      cursor?.id ?? null,
    ],
  );
  return {
    loads: rows.slice(0, limit).map(({ cursor_at, ...load }) => {
      void cursor_at;
      return load;
    }),
    nextCursor:
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({
              at: rows[limit - 1].cursor_at,
              id: rows[limit - 1].id,
            }),
          ).toString("base64url")
        : null,
  };
}
export async function detail(user: string, id: string) {
  return transaction(async (c) => {
    const load = await scoped(c, user, id);
    const stops = await c.query(
      "SELECT * FROM load_stops WHERE load_id=$1 ORDER BY sequence",
      [id],
    );
    const events = await c.query(
      "SELECT id,type,payload,created_at FROM load_events WHERE load_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101",
      [id],
    );
    const assignment = await c.query(
      "SELECT a.*,d.name FROM load_assignments a JOIN drivers d ON d.id=a.driver_id WHERE load_id=$1",
      [id],
    );
    const checkIns = await c.query(
      `SELECT ci.id,ci.location,ci.note,ci.source,ci.observed_at,ci.recorded_at,u.name actor_name
       FROM check_ins ci JOIN users u ON u.id=ci.actor_id
       WHERE ci.load_id=$1 AND ci.carrier_id=$2
       ORDER BY ci.observed_at DESC,ci.recorded_at DESC,ci.id DESC LIMIT 50`,
      [id, load.carrier_id],
    );
    const documents = await loadDocumentSlots(c, id);
    const exceptions = await loadExceptions(c, id);
    return {
      ...load,
      stops: stops.rows,
      events: events.rows.slice(0, 100).reverse(),
      events_truncated: events.rows.length > 100,
      assignment: assignment.rows[0] ?? null,
      check_ins: checkIns.rows,
      documents,
      exceptions,
      exception_suggestions: suggestExceptions(
        { stage: load.stage, stops: stops.rows, documents, exceptions },
        Date.now(),
      ),
      exception_owners: await exceptionOwners(c, load.carrier_id),
    };
  });
}
export const checkInSchema = z
  .object({
    version: z.number().int().positive(),
    location: z.string().trim().min(1).max(160),
    note: z.string().trim().max(1000).default(""),
    observed_at: z.iso.datetime({ offset: true }),
    idempotency_key: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();

export async function recordCheckIn(user: string, id: string, input: unknown) {
  const data = checkInSchema.parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, id, true, true);
    // Recheck after taking the load lock: an assignment or membership may have
    // changed while this statement waited for a concurrent writer to commit.
    const membership = await member(c, user, load.carrier_id);
    if (membership.role === "driver") {
      const assigned = await c.query(
        "SELECT 1 FROM load_assignments WHERE load_id=$1 AND driver_id=$2",
        [id, membership.driver_id],
      );
      if (!assigned.rowCount) throw new HttpError(404, "NOT_FOUND");
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":check-in:" + data.idempotency_key,
    ]);
    const { idempotency_key, ...observation } = data;
    const hash = digest(JSON.stringify({ load_id: load.id, ...observation }));
    const old = await c.query(
      "SELECT id,load_id,load_version,request_hash FROM check_ins WHERE actor_id=$1 AND idempotency_key=$2",
      [user, idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return {
        id: old.rows[0].load_id,
        version: old.rows[0].load_version,
        check_in_id: old.rows[0].id,
      };
    }
    if (load.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    const observedAt = Date.parse(data.observed_at);
    const now = Date.now();
    if (observedAt > now + 5 * 60_000 || observedAt < now - 30 * 86_400_000)
      throw new HttpError(422, "CHECK_IN_TIME_OUT_OF_RANGE");
    const checkInId = randomUUID();
    const version = load.version + 1;
    await c.query(
      `INSERT INTO check_ins(id,load_id,carrier_id,actor_id,location,note,observed_at,load_version,idempotency_key,request_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        checkInId,
        id,
        load.carrier_id,
        user,
        data.location,
        data.note,
        data.observed_at,
        version,
        idempotency_key,
        hash,
      ],
    );
    await c.query("UPDATE loads SET version=$2 WHERE id=$1", [id, version]);
    await event(c, user, load, "load.check-in", {
      check_in_id: checkInId,
      source: "manual",
      location: data.location,
      note: data.note,
      observed_at: data.observed_at,
    });
    return { id, version, check_in_id: checkInId };
  });
}
export async function mutate(
  user: string,
  id: string,
  action: string,
  input: unknown,
) {
  const data = z
    .object({
      version: z.number().int().positive(),
      driverId: z.uuid().optional(),
      stage: z.enum(["dispatched", "picked-up", "delivered"]).optional(),
    })
    .parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, id, true);
    if (load.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (action === "assign") {
      await requireAgreement(c, load.carrier_id);
      if (!data.driverId) throw new HttpError(400, "DRIVER_REQUIRED");
      const driver = await c.query(
        "SELECT 1 FROM drivers WHERE id=$1 AND carrier_id=$2 AND onboarding_status='ready'",
        [data.driverId, load.carrier_id],
      );
      if (!driver.rowCount) throw new HttpError(422, "DRIVER_CARRIER_MISMATCH");
      if (load.stage === "delivered")
        throw new HttpError(422, "LOAD_DELIVERED");
      await c.query(
        "INSERT INTO load_assignments(load_id,carrier_id,driver_id) VALUES($1,$2,$3) ON CONFLICT(load_id) DO UPDATE SET driver_id=$3",
        [id, load.carrier_id, data.driverId],
      );
      const recipients = await c.query(
        `SELECT m.user_id,c.organization_id,
          (SELECT address FROM load_stops WHERE load_id=$1 AND sequence=1) pickup,
          (SELECT window_start FROM load_stops WHERE load_id=$1 AND sequence=1) pickup_at,
          (SELECT timezone FROM load_stops WHERE load_id=$1 AND sequence=1) pickup_zone,
          (SELECT address FROM load_stops WHERE load_id=$1 ORDER BY sequence DESC LIMIT 1) delivery,
          (SELECT count(*)::int FROM load_stops WHERE load_id=$1) stop_count
        FROM memberships m JOIN carriers c ON c.id=m.carrier_id
        WHERE m.carrier_id=$2 AND m.driver_id=$3`,
        [id, load.carrier_id, data.driverId],
      );
      for (const r of recipients.rows)
        await enqueueForUser(c, r.user_id, {
          kind: "assignment",
          organization: r.organization_id,
          dedupe: `assignment:${id}:${data.driverId}:${load.version + 1}`,
          subject: `Load ${load.reference} assigned to you`,
          text: `You've been assigned load ${load.reference}.\n\nPickup: ${r.pickup} — ${new Date(r.pickup_at).toLocaleString("en-US", { timeZone: r.pickup_zone, dateStyle: "medium", timeStyle: "short" })} (${r.pickup_zone})\nFinal delivery: ${r.delivery}${r.stop_count > 2 ? ` (${r.stop_count} stops in total)` : ""}\n\nOpen Relay for details and to record check-ins.`,
        });
    } else {
      const stages = ["booked", "dispatched", "picked-up", "delivered"];
      if (
        !data.stage ||
        stages.indexOf(data.stage) !== stages.indexOf(load.stage) + 1
      )
        throw new HttpError(422, "INVALID_TRANSITION");
      const a = await c.query(
        "SELECT 1 FROM load_assignments WHERE load_id=$1",
        [id],
      );
      if (!a.rowCount) throw new HttpError(422, "ASSIGN_DRIVER_FIRST");
      await c.query("UPDATE loads SET stage=$2 WHERE id=$1", [id, data.stage]);
    }
    await c.query("UPDATE loads SET version=version+1 WHERE id=$1", [id]);
    await event(c, user, load, "load." + action, data);
    return { id, version: load.version + 1 };
  });
}
