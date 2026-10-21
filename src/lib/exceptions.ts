import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { event, member, scoped } from "./loads";
import { loadDocumentTypes } from "./compliance";
import {
  exceptionSeverities,
  exceptionStatuses,
  exceptionTypes,
  type LoadException,
} from "./exception-rules";

const exceptionColumns = `e.id,e.load_id,e.carrier_id,e.type,e.severity,e.status,e.summary,e.details,
  e.document_type,e.owner_id,o.name owner_name,e.due_at,ob.name opened_by_name,e.opened_at,
  rb.name resolved_by_name,e.resolved_at,e.resolution,e.version`;
const exceptionJoins = `JOIN users ob ON ob.id=e.opened_by
  LEFT JOIN users o ON o.id=e.owner_id LEFT JOIN users rb ON rb.id=e.resolved_by`;

export async function loadExceptions(
  c: PoolClient,
  loadId: string,
): Promise<LoadException[]> {
  const { rows } = await c.query(
    `SELECT ${exceptionColumns} FROM load_exceptions e ${exceptionJoins}
    WHERE e.load_id=$1 ORDER BY (e.status='resolved'),e.opened_at DESC LIMIT 100`,
    [loadId],
  );
  return rows;
}
/** People who may own exceptions for a carrier: its dispatchers and managers. */
export async function exceptionOwners(c: PoolClient, carrierId: string) {
  const { rows } = await c.query(
    `SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.carrier_id=$1 AND m.role IN ('dispatcher','carrier-manager') ORDER BY u.name,u.id`,
    [carrierId],
  );
  return rows as { id: string; name: string; role: string }[];
}
async function requireOwner(c: PoolClient, carrierId: string, owner: string) {
  const { rowCount } = await c.query(
    "SELECT 1 FROM memberships WHERE carrier_id=$1 AND user_id=$2 AND role IN ('dispatcher','carrier-manager')",
    [carrierId, owner],
  );
  if (!rowCount) throw new HttpError(422, "OWNER_NOT_ELIGIBLE");
}
export const openSchema = z
  .object({
    type: z.enum(exceptionTypes),
    severity: z.enum(exceptionSeverities),
    summary: z.string().trim().min(1).max(200),
    details: z.string().trim().max(1000).default(""),
    document_type: z.enum(loadDocumentTypes).optional(),
    owner_id: z.uuid().optional(),
    due_at: z.iso.datetime({ offset: true }).optional(),
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
  })
  .strict()
  .refine((d) => (d.type === "missing_document") === Boolean(d.document_type), {
    message: "Missing-document exceptions name exactly one document type",
  });

export async function openException(
  user: string,
  loadId: string,
  input: unknown,
) {
  const data = openSchema.parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, loadId, true, true);
    const membership = await member(c, user, load.carrier_id);
    if (membership.role === "driver") {
      const assigned = await c.query(
        "SELECT 1 FROM load_assignments WHERE load_id=$1 AND driver_id=$2",
        [loadId, membership.driver_id],
      );
      if (!assigned.rowCount) throw new HttpError(404, "NOT_FOUND");
      // Drivers report; dispatch decides ownership and deadlines.
      if (data.owner_id || data.due_at)
        throw new HttpError(403, "ROLE_NOT_PERMITTED");
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":exception:" + data.idempotency_key,
    ]);
    const { idempotency_key, ...fields } = data;
    const hash = digest(JSON.stringify({ load_id: loadId, ...fields }));
    const old = await c.query(
      "SELECT id,version,request_hash FROM load_exceptions WHERE opened_by=$1 AND idempotency_key=$2",
      [user, idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { id: old.rows[0].id, version: old.rows[0].version };
    }
    if (data.owner_id) await requireOwner(c, load.carrier_id, data.owner_id);
    const id = randomUUID();
    await c.query(
      `INSERT INTO load_exceptions(id,load_id,carrier_id,type,severity,summary,details,document_type,owner_id,due_at,opened_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        loadId,
        load.carrier_id,
        data.type,
        data.severity,
        data.summary,
        data.details,
        data.document_type ?? null,
        data.owner_id ?? null,
        data.due_at ?? null,
        user,
        idempotency_key,
        hash,
      ],
    );
    await event(c, user, load, "exception.opened", {
      exception_id: id,
      type: data.type,
      severity: data.severity,
      owner_id: data.owner_id ?? null,
    });
    return { id, version: 1 };
  });
}

export const updateSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("assign"),
      version: z.number().int().positive(),
      owner_id: z.uuid().nullable(),
      due_at: z.iso.datetime({ offset: true }).nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("start"),
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      version: z.number().int().positive(),
      resolution: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("reopen"),
      version: z.number().int().positive(),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);

export async function updateException(
  user: string,
  id: string,
  input: unknown,
) {
  const data = updateSchema.parse(input);
  return transaction(async (c) => {
    // Lock the exception only when the caller manages its carrier. Drivers
    // and foreign members receive the same 404 as a missing record.
    const { rows } = await c.query(
      `SELECT e.* FROM load_exceptions e JOIN memberships m ON m.carrier_id=e.carrier_id AND m.user_id=$2
      WHERE e.id=$1 AND m.role IN ('dispatcher','carrier-manager') FOR UPDATE OF e`,
      [id, user],
    );
    const current = rows[0];
    if (!current) throw new HttpError(404, "NOT_FOUND");
    if (current.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    const load = { id: current.load_id, carrier_id: current.carrier_id };
    if (data.action === "assign") {
      if (current.status === "resolved")
        throw new HttpError(422, "EXCEPTION_RESOLVED");
      if (data.owner_id)
        await requireOwner(c, current.carrier_id, data.owner_id);
      await c.query(
        "UPDATE load_exceptions SET owner_id=$2,due_at=CASE WHEN $4 THEN $3::timestamptz ELSE due_at END WHERE id=$1",
        [id, data.owner_id, data.due_at ?? null, data.due_at !== undefined],
      );
      await event(c, user, load, "exception.assigned", {
        exception_id: id,
        owner_id: data.owner_id,
      });
    } else if (data.action === "start") {
      if (current.status !== "open")
        throw new HttpError(422, "INVALID_TRANSITION");
      await c.query(
        "UPDATE load_exceptions SET status='in_progress' WHERE id=$1",
        [id],
      );
      await event(c, user, load, "exception.started", { exception_id: id });
    } else if (data.action === "resolve") {
      if (current.status === "resolved")
        throw new HttpError(422, "EXCEPTION_RESOLVED");
      await c.query(
        "UPDATE load_exceptions SET status='resolved',resolved_by=$2,resolved_at=now(),resolution=$3 WHERE id=$1",
        [id, user, data.resolution],
      );
      await event(c, user, load, "exception.resolved", {
        exception_id: id,
        resolution: data.resolution,
      });
    } else {
      if (current.status !== "resolved")
        throw new HttpError(422, "INVALID_TRANSITION");
      await c.query(
        "UPDATE load_exceptions SET status='open',resolved_by=NULL,resolved_at=NULL,resolution=NULL WHERE id=$1",
        [id],
      );
      await event(c, user, load, "exception.reopened", {
        exception_id: id,
        reason: data.reason,
      });
    }
    await c.query(
      "UPDATE load_exceptions SET version=version+1,updated_at=now() WHERE id=$1",
      [id],
    );
    return { id, version: current.version + 1 };
  });
}

export async function listExceptions(user: string, params: URLSearchParams) {
  const filters = z
    .object({
      status: z.enum([...exceptionStatuses, "active", "all"]).default("active"),
      owner: z.enum(["me", "unassigned", "any"]).default("any"),
      carrier_id: z.uuid().optional(),
      overdue: z.enum(["true", "false"]).optional(),
    })
    .parse({
      status: params.get("status") ?? undefined,
      owner: params.get("owner") ?? undefined,
      carrier_id: params.get("carrier_id") ?? undefined,
      overdue: params.get("overdue") ?? undefined,
    });
  const { rows } = await pool.query(
    `SELECT ${exceptionColumns},l.reference load_reference,c.name carrier_name
    FROM load_exceptions e ${exceptionJoins}
    JOIN loads l ON l.id=e.load_id JOIN carriers c ON c.id=e.carrier_id
    JOIN memberships m ON m.carrier_id=e.carrier_id AND m.user_id=$1
    WHERE (m.role<>'driver' OR EXISTS(SELECT 1 FROM load_assignments a WHERE a.load_id=e.load_id AND a.driver_id=m.driver_id))
      AND ($2='all' OR ($2='active' AND e.status<>'resolved') OR e.status=$2)
      AND ($3='any' OR ($3='me' AND e.owner_id=$1) OR ($3='unassigned' AND e.owner_id IS NULL))
      AND ($4::uuid IS NULL OR e.carrier_id=$4)
      AND ($5::boolean IS NOT TRUE OR (e.status<>'resolved' AND e.due_at<now()))
    ORDER BY (e.status='resolved'),
      CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      e.due_at NULLS LAST,e.opened_at DESC,e.id
    LIMIT 101`,
    [
      user,
      filters.status,
      filters.owner,
      filters.carrier_id ?? null,
      filters.overdue === undefined ? null : filters.overdue === "true",
    ],
  );
  return { exceptions: rows.slice(0, 100), truncated: rows.length > 100 };
}
