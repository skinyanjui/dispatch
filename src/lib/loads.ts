import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError, digest } from "./auth";
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
    stops: z.array(stop).length(2),
  })
  .refine(
    (s) =>
      s.stops[0].kind === "pickup" &&
      s.stops[1].kind === "delivery" &&
      Date.parse(s.stops[1].windowStart) >= Date.parse(s.stops[0].windowEnd),
    "Pickup must precede delivery",
  );
export async function auditDenied(user: string, resource: string) {
  await pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    "access.denied",
    resource,
  ]);
}
async function member(
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
async function scoped(c: PoolClient, user: string, id: string, write = false) {
  const { rows } = await c.query("SELECT * FROM loads WHERE id=$1 FOR UPDATE", [
    id,
  ]);
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  const m = await member(c, user, rows[0].carrier_id, write);
  if (m.role === "driver") {
    const a = await c.query(
      "SELECT 1 FROM load_assignments WHERE load_id=$1 AND driver_id=$2",
      [id, m.driver_id],
    );
    if (!a.rowCount) throw new HttpError(404, "NOT_FOUND");
  }
  return rows[0];
}
async function event(
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
    const auth = await c.query(
      "SELECT 1 FROM carrier_dispatch_authorizations WHERE carrier_id=$1 AND verified_at<=now() AND effective_at<=now() AND expires_at>now() FOR SHARE",
      [data.carrierId],
    );
    if (!auth.rowCount)
      throw new HttpError(422, "CARRIER_AUTHORIZATION_REQUIRED");
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
  const offset = Number(params.get("cursor") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new HttpError(400, "INVALID_CURSOR");
  const { rows } = await pool.query(
    `SELECT l.*,c.name carrier_name,(SELECT address FROM load_stops WHERE load_id=l.id AND sequence=1) pickup,(SELECT address FROM load_stops WHERE load_id=l.id AND sequence=2) delivery FROM loads l JOIN carriers c ON c.id=l.carrier_id JOIN memberships m ON m.carrier_id=l.carrier_id AND m.user_id=$1 LEFT JOIN load_assignments a ON a.load_id=l.id WHERE (m.role<>'driver' OR a.driver_id=m.driver_id) AND ($2::text IS NULL OR l.carrier_id::text=$2) AND ($3::text IS NULL OR l.stage=$3) AND ($4::text IS NULL OR l.reference ILIKE '%'||$4||'%') ORDER BY l.created_at DESC,l.id LIMIT $5 OFFSET $6`,
    [
      user,
      params.get("carrier_id"),
      params.get("status"),
      params.get("q"),
      limit + 1,
      offset,
    ],
  );
  return {
    loads: rows.slice(0, limit),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
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
      "SELECT id,type,payload,created_at FROM load_events WHERE load_id=$1 ORDER BY created_at",
      [id],
    );
    const assignment = await c.query(
      "SELECT a.*,d.name FROM load_assignments a JOIN drivers d ON d.id=a.driver_id WHERE load_id=$1",
      [id],
    );
    return {
      ...load,
      stops: stops.rows,
      events: events.rows,
      assignment: assignment.rows[0] ?? null,
    };
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
      if (!data.driverId) throw new HttpError(400, "DRIVER_REQUIRED");
      const driver = await c.query(
        "SELECT 1 FROM drivers WHERE id=$1 AND carrier_id=$2",
        [data.driverId, load.carrier_id],
      );
      if (!driver.rowCount) throw new HttpError(422, "DRIVER_CARRIER_MISMATCH");
      if (load.stage === "delivered")
        throw new HttpError(422, "LOAD_DELIVERED");
      await c.query(
        "INSERT INTO load_assignments(load_id,carrier_id,driver_id) VALUES($1,$2,$3) ON CONFLICT(load_id) DO UPDATE SET driver_id=$3",
        [id, load.carrier_id, data.driverId],
      );
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
