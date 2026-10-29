import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { event, scoped } from "./loads";
import { enqueueForUser } from "./notifications";
import { requestChange } from "./change-control";

// Edits and cancellation (ADR 0019). Every change names the actor, keeps the
// old value and, once a load is past booking, a reason.

const timezone = z.string().refine((s) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");
export const editSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().max(500).default(""),
    reference: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().min(1).max(100).optional(),
    amountMinor: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    stops: z
      .array(
        z
          .object({
            id: z.uuid(),
            address: z.string().trim().min(3).max(500).optional(),
            timezone: timezone.optional(),
            windowStart: z.iso.datetime({ offset: true }).optional(),
            windowEnd: z.iso.datetime({ offset: true }).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export const cancelParties = ["payer", "carrier", "dispatch", "other"] as const;
export const cancelSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    // Who cancelled the order. Required once the load is dispatched, because
    // a truck-ordered-not-used fee is owed only when the payer cancelled (ADR 0070).
    party: z.enum(cancelParties).optional(),
  })
  .strict();

type Change = {
  field: string;
  stop?: string;
  old: string;
  next: string;
};

/** Tells the assigned driver (if any) that their load changed. */
async function notifyDriver(
  c: PoolClient,
  load: { id: string; carrier_id: string; reference: string },
  version: number,
  subject: string,
  text: string,
) {
  const { rows } = await c.query(
    `SELECT m.user_id,car.organization_id FROM load_assignments a
    JOIN memberships m ON m.driver_id=a.driver_id AND m.carrier_id=a.carrier_id
    JOIN carriers car ON car.id=a.carrier_id WHERE a.load_id=$1`,
    [load.id],
  );
  for (const r of rows)
    await enqueueForUser(c, r.user_id, {
      kind: "assignment",
      organization: r.organization_id,
      dedupe: `load-change:${load.id}:${version}:${r.user_id}`,
      subject,
      text,
    });
}

/**
 * Replays the stored result when this actor already applied the same request
 * under the same key. Returns null when the key is new (or none was sent).
 * Runs after `scoped`, so a foreign load is NOT_FOUND before any replay.
 */
async function replay(
  c: PoolClient,
  user: string,
  load: { id: string },
  kind: "edit" | "cancel",
  key: string | undefined,
  body: unknown,
) {
  if (key === undefined) return null;
  if (!key || key.length > 128)
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    user + ":load-change:" + key,
  ]);
  const old = await c.query(
    "SELECT load_id,kind,request_hash,result FROM load_change_requests WHERE actor_id=$1 AND idempotency_key=$2",
    [user, key],
  );
  const row = old.rows[0];
  if (!row) return null;
  if (
    row.load_id !== load.id ||
    row.kind !== kind ||
    row.request_hash !== digest(JSON.stringify(body))
  )
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return row.result as { id: string; version: number };
}
async function remember(
  c: PoolClient,
  user: string,
  load: { id: string; carrier_id: string },
  kind: "edit" | "cancel",
  key: string | undefined,
  body: unknown,
  result: object,
) {
  if (key === undefined) return;
  await c.query(
    "INSERT INTO load_change_requests(actor_id,idempotency_key,load_id,carrier_id,kind,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      user,
      key,
      load.id,
      load.carrier_id,
      kind,
      digest(JSON.stringify(body)),
      JSON.stringify(result),
    ],
  );
}

export async function editLoad(
  user: string,
  id: string,
  input: unknown,
  key?: string,
) {
  const data = editSchema.parse(input);
  return transaction((c) => editLoadIn(c, user, id, data, key, false));
}

type EditResult = {
  id: string;
  version: number;
  change_group?: string;
  /** Set when a reroute waits for a second person (ADR 0064). */
  pending_approval?: true;
  change_id?: string;
};

/**
 * The edit itself, inside the caller's transaction. A change of stop address
 * on a load that has left "booked" is a reroute: unless `approved`, it is
 * parked as a sensitive change for a second person instead of being applied.
 */
export async function editLoadIn(
  c: PoolClient,
  user: string,
  id: string,
  data: z.infer<typeof editSchema>,
  key: string | undefined,
  approved: boolean,
): Promise<EditResult> {
  {
    // A replayed request must not trip over its own cancellation or version.
    const load = await scoped(c, user, id, true, false, true);
    const again = await replay(c, user, load, "edit", key, data);
    if (again) return again;
    if (load.cancelled_at) throw new HttpError(409, "LOAD_CANCELLED");
    if (load.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (load.stage === "delivered") throw new HttpError(422, "LOAD_LOCKED");
    if (load.stage !== "booked" && !data.reason)
      throw new HttpError(422, "REASON_REQUIRED");
    const changes: Change[] = [];
    const scalar = (field: string, old: unknown, next: unknown) => {
      if (next !== undefined && String(next) !== String(old))
        changes.push({ field, old: String(old), next: String(next) });
    };
    scalar("reference", load.reference, data.reference);
    scalar("source", load.source, data.source);
    scalar("amount_minor", load.amount_minor, data.amountMinor);
    const stops = (
      await c.query(
        `SELECT s.*,EXISTS(SELECT 1 FROM stop_events e WHERE e.stop_id=s.id) started
        FROM load_stops s WHERE s.load_id=$1 ORDER BY s.sequence`,
        [id],
      )
    ).rows;
    const merged = stops.map((s) => ({
      ...s,
      window_start: new Date(s.window_start).toISOString(),
      window_end: new Date(s.window_end).toISOString(),
    }));
    for (const edit of data.stops ?? []) {
      const stop = merged.find((s) => s.id === edit.id);
      if (!stop) throw new HttpError(404, "NOT_FOUND");
      const before = { ...stop };
      if (edit.address !== undefined) stop.address = edit.address;
      if (edit.timezone !== undefined) stop.timezone = edit.timezone;
      if (edit.windowStart !== undefined)
        stop.window_start = new Date(edit.windowStart).toISOString();
      if (edit.windowEnd !== undefined)
        stop.window_end = new Date(edit.windowEnd).toISOString();
      const touched = (
        [
          ["address", "address"],
          ["timezone", "timezone"],
          ["window_start", "window_start"],
          ["window_end", "window_end"],
        ] as const
      ).filter(([, key]) => before[key] !== stop[key]);
      if (touched.length && stop.started)
        throw new HttpError(422, "STOP_ALREADY_STARTED");
      for (const [field, key] of touched)
        changes.push({
          field,
          stop: stop.id,
          old: String(before[key]),
          next: String(stop[key]),
        });
    }
    if (!changes.length) throw new HttpError(422, "NO_CHANGES");
    if (
      !approved &&
      load.stage !== "booked" &&
      changes.some((x) => x.field === "address")
    ) {
      const moved = changes.filter((x) => x.field === "address");
      const change = await requestChange(c, user, {
        carrierId: load.carrier_id,
        kind: "reroute",
        subjectId: id,
        summary:
          `Reroute load ${load.reference}: ${moved.map((x) => `${x.old} to ${x.next}`).join("; ")}`.slice(
            0,
            300,
          ),
        current: { stops: moved.map((x) => ({ id: x.stop, address: x.old })) },
        proposed: data,
        reason: data.reason,
      });
      return {
        id,
        version: load.version,
        pending_approval: true,
        change_id: change,
      };
    }
    for (const [i, s] of merged.entries()) {
      if (Date.parse(s.window_end) < Date.parse(s.window_start))
        throw new HttpError(422, "INVALID_STOP_WINDOWS");
      if (
        i > 0 &&
        Date.parse(s.window_start) < Date.parse(merged[i - 1].window_end)
      )
        throw new HttpError(422, "INVALID_STOP_WINDOWS");
    }
    try {
      await c.query(
        "UPDATE loads SET reference=$2,source=$3,amount_minor=$4,version=version+1 WHERE id=$1",
        [
          id,
          data.reference ?? load.reference,
          data.source ?? load.source,
          data.amountMinor ?? load.amount_minor,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new HttpError(409, "REFERENCE_TAKEN");
      throw e;
    }
    for (const edit of data.stops ?? []) {
      const s = merged.find((x) => x.id === edit.id)!;
      await c.query(
        "UPDATE load_stops SET address=$2,timezone=$3,window_start=$4,window_end=$5 WHERE id=$1",
        [s.id, s.address, s.timezone, s.window_start, s.window_end],
      );
    }
    const group = randomUUID();
    for (const ch of changes)
      await c.query(
        "INSERT INTO load_changes(id,change_group,load_id,carrier_id,actor_id,stop_id,field,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          randomUUID(),
          group,
          id,
          load.carrier_id,
          user,
          ch.stop ?? null,
          ch.field,
          ch.old,
          ch.next,
          data.reason,
        ],
      );
    const version = load.version + 1;
    await event(c, user, load, "load.edited", {
      change_group: group,
      fields: changes.map((x) => x.field),
      reason: data.reason,
    });
    const schedule = changes.filter((x) => x.stop);
    if (schedule.length)
      await notifyDriver(
        c,
        load,
        version,
        `Load ${data.reference ?? load.reference} was updated`,
        `Heads up: dispatch updated pickup or delivery details for load ${data.reference ?? load.reference}.${data.reason ? `\n\nReason: ${data.reason}` : ""}\n\nOpen Relay to see the latest addresses and appointment times. Thanks for staying flexible!`,
      );
    const result = { id, version, change_group: group };
    await remember(c, user, load, "edit", key, data, result);
    return result;
  }
}

export async function cancelLoad(
  user: string,
  id: string,
  input: unknown,
  key?: string,
) {
  const data = cancelSchema.parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, id, true, false, true);
    const again = await replay(c, user, load, "cancel", key, data);
    if (again) return again;
    if (load.cancelled_at) throw new HttpError(409, "LOAD_CANCELLED");
    if (load.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (load.stage !== "booked" && load.stage !== "dispatched")
      throw new HttpError(422, "CANNOT_CANCEL_STARTED");
    if (load.stage === "dispatched" && !data.party)
      throw new HttpError(422, "CANCEL_PARTY_REQUIRED");
    const version = load.version + 1;
    await c.query(
      "UPDATE loads SET cancelled_at=now(),cancelled_by=$2,cancel_reason=$3,cancel_party=$5,version=$4 WHERE id=$1",
      [id, user, data.reason, version, data.party ?? null],
    );
    // Open exceptions on freight that will not move are closed with the reason.
    await c.query(
      `UPDATE load_exceptions SET status='resolved',resolved_by=$2,resolved_at=now(),
        resolution=$3,version=version+1,updated_at=now() WHERE load_id=$1 AND status<>'resolved'`,
      [id, user, "Load cancelled: " + data.reason.slice(0, 900)],
    );
    await event(c, user, load, "load.cancelled", {
      reason: data.reason,
      party: data.party ?? null,
    });
    await notifyDriver(
      c,
      load,
      version,
      `Load ${load.reference} was cancelled`,
      `Load ${load.reference} was cancelled. Please don't pick it up. Sorry for the change of plans!\n\nReason: ${data.reason}`,
    );
    const result = { id, version };
    await remember(c, user, load, "cancel", key, data, result);
    return result;
  });
}

export async function loadChanges(c: PoolClient, loadId: string) {
  const { rows } = await c.query(
    `SELECT ch.change_group,ch.field,ch.stop_id,ch.old_value,ch.new_value,ch.reason,ch.created_at,u.name actor_name
    FROM load_changes ch JOIN users u ON u.id=ch.actor_id
    WHERE ch.load_id=$1 ORDER BY ch.created_at DESC,ch.id LIMIT 100`,
    [loadId],
  );
  return rows;
}
