import { z } from "zod";
import { pool } from "@/lib/db";
import { HttpError } from "@/lib/auth";
import { auditLabel } from "@/lib/audit-labels";

/**
 * The audit log as organization owners and admins see it (ADR 0047). The log
 * itself is written everywhere through `audit_logs`; the organization column
 * is filled by a trigger from the actor. This module only reads it.
 */
const pageSize = 50;

/** Organizations the person administers; none means there is no audit page. */
async function adminOrganizations(user: string) {
  const r = await pool.query(
    "SELECT organization_id FROM organization_members WHERE user_id=$1",
    [user],
  );
  if (!r.rowCount) throw new HttpError(404, "NOT_FOUND");
  return r.rows.map((x) => x.organization_id as string);
}

/** Records that the log was opened, at most once in ten minutes per person, so
 *  filtering and paging do not flood it. */
async function noteViewed(user: string) {
  await pool.query(
    `INSERT INTO audit_logs(id,actor_id,action,resource_id)
     SELECT gen_random_uuid(),$1,'audit.viewed',NULL
     WHERE NOT EXISTS(SELECT 1 FROM audit_logs WHERE actor_id=$1 AND action='audit.viewed'
       AND created_at>now()-interval '10 minutes')`,
    [user],
  );
}

const query = z
  .object({
    action: z.string().min(1).max(80).nullable(),
    actor: z.uuid().nullable(),
    q: z.string().max(80).nullable(),
    from: z.iso.date().nullable(),
    to: z.iso.date().nullable(),
    cursor: z.string().max(200).nullable(),
  })
  .strict();

function cursorOf(value: string | null) {
  if (!value) return null;
  const m = /^(\d{1,16})\.([0-9a-f-]{36})$/.exec(value);
  if (!m) throw new HttpError(400, "VALIDATION_ERROR");
  return { micros: m[1], id: m[2] };
}

const like = (s: string) => "%" + s.replace(/[\\%_]/g, "\\$&") + "%";

export async function auditLog(user: string, params: URLSearchParams) {
  const orgs = await adminOrganizations(user);
  const f = query.parse({
    action: params.get("action"),
    actor: params.get("actor"),
    q: params.get("q"),
    from: params.get("from"),
    to: params.get("to"),
    cursor: params.get("cursor"),
  });
  const cur = cursorOf(f.cursor);
  const rows = await pool.query(
    `SELECT a.id,a.action,a.resource_id,a.created_at,
       (extract(epoch FROM a.created_at)*1000000)::bigint::text micros,
       u.id actor_id,u.name actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.organization_id=ANY($1::uuid[])
       AND ($2::text IS NULL OR a.action=$2)
       AND ($3::uuid IS NULL OR a.actor_id=$3)
       AND ($4::text IS NULL OR a.action ILIKE $4 OR u.name ILIKE $4 OR a.resource_id ILIKE $4)
       AND ($5::date IS NULL OR a.created_at>=$5::date)
       AND ($6::date IS NULL OR a.created_at<($6::date+1))
       AND ($7::bigint IS NULL OR (
         -- exact integer microseconds decide; the bound lets the index narrow the scan
         a.created_at<=to_timestamp($7::bigint/1000000.0)+interval '1 microsecond'
         AND ((extract(epoch FROM a.created_at)*1000000)::bigint,a.id)<($7::bigint,$8::uuid)))
     ORDER BY a.created_at DESC,a.id DESC LIMIT $9`,
    [
      orgs,
      f.action,
      f.actor,
      f.q ? like(f.q) : null,
      f.from,
      f.to,
      cur?.micros ?? null,
      cur?.id ?? null,
      pageSize + 1,
    ],
  );
  const more = rows.rows.length > pageSize;
  const page = rows.rows.slice(0, pageSize);
  await noteViewed(user);
  const last = page.at(-1);
  return {
    entries: page.map((r) => ({
      id: r.id as string,
      at: (r.created_at as Date).toISOString(),
      actor: r.actor_id
        ? { id: r.actor_id as string, name: r.actor_name as string }
        : null,
      action: r.action as string,
      label: auditLabel(r.action),
      resource_id: (r.resource_id as string | null) ?? null,
    })),
    next_cursor: more && last ? `${last.micros}.${last.id}` : null,
  };
}

/** Values for the filter menus: what has actually been recorded. */
export async function auditFilters(user: string) {
  const orgs = await adminOrganizations(user);
  const actions = await pool.query(
    "SELECT DISTINCT action FROM audit_logs WHERE organization_id=ANY($1::uuid[]) ORDER BY action LIMIT 300",
    [orgs],
  );
  const actors = await pool.query(
    `SELECT DISTINCT u.id,u.name FROM audit_logs a JOIN users u ON u.id=a.actor_id
     WHERE a.organization_id=ANY($1::uuid[]) ORDER BY u.name,u.id LIMIT 300`,
    [orgs],
  );
  return {
    actions: actions.rows.map((r) => ({
      action: r.action as string,
      label: auditLabel(r.action),
    })),
    actors: actors.rows as { id: string; name: string }[],
  };
}
