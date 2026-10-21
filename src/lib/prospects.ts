import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { access } from "./contacts";
import { emit } from "./onboarding";
import {
  activityKinds,
  prospectSources,
  prospectStages,
  type Prospect,
  type ProspectActivity,
  type ProspectDetail,
  type ProspectList,
} from "./prospect-types";

/**
 * Prospects belong to the dispatch organization (ADR 0030). Only organization
 * staff (owners, admins and dispatchers) can see or change them. Carrier
 * managers and drivers, and other organizations, always get NOT_FOUND: a
 * prospect is a sales record, not a carrier, and carries no access.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).default("");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  });

export const prospectFields = z
  .object({
    company: text(160),
    contact_name: optional(160),
    email: z
      .string()
      .trim()
      .max(254)
      .pipe(z.union([z.email(), z.literal("")]))
      .transform((v) => v.toLowerCase())
      .default(""),
    phone: optional(40),
    usdot: z
      .string()
      .trim()
      .regex(/^\d{1,8}$|^$/)
      .default(""),
    truck_count: z.number().int().min(0).max(100000).nullable().default(null),
    source: z.enum(prospectSources).default("other"),
    owner_id: z.uuid().nullable().default(null),
    next_follow_up_on: date.nullable().default(null),
    notes: optional(2000),
  })
  .strict();

const SELECT = `SELECT p.*,to_char(p.next_follow_up_on,'YYYY-MM-DD') AS follow_up,
  o.name AS owner_name,
  (SELECT max(created_at) FROM prospect_activities a WHERE a.prospect_id=p.id) AS last_activity_at
  FROM prospects p LEFT JOIN users o ON o.id=p.owner_id`;

function shape(r: Record<string, unknown>): Prospect {
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    company: r.company as string,
    contact_name: r.contact_name as string,
    email: r.email as string,
    phone: r.phone as string,
    usdot: r.usdot as string,
    truck_count: (r.truck_count as number | null) ?? null,
    source: r.source as Prospect["source"],
    stage: r.stage as Prospect["stage"],
    lost_reason: r.lost_reason as string,
    owner: r.owner_id
      ? { id: r.owner_id as string, name: r.owner_name as string }
      : null,
    next_follow_up_on: (r.follow_up as string | null) ?? null,
    notes: r.notes as string,
    carrier_id: (r.carrier_id as string | null) ?? null,
    stage_changed_at: (r.stage_changed_at as Date).toISOString(),
    last_activity_at: r.last_activity_at
      ? (r.last_activity_at as Date).toISOString()
      : null,
    version: r.version as number,
  };
}

async function staffOrganizations(c: PoolClient | typeof pool, user: string) {
  const a = await access(c, user);
  if (!a.organizations.length) throw new HttpError(404, "NOT_FOUND");
  return a.organizations;
}
/** Everyone in an organization who could own a prospect. */
async function teamOf(c: PoolClient | typeof pool, orgs: string[]) {
  const { rows } = await c.query(
    `SELECT DISTINCT t.organization_id,u.id,u.name FROM (
      SELECT organization_id,user_id FROM organization_members
      UNION SELECT c.organization_id,m.user_id FROM carriers c
        JOIN memberships m ON m.carrier_id=c.id AND m.role='dispatcher') t
    JOIN users u ON u.id=t.user_id WHERE t.organization_id=ANY($1::uuid[]) ORDER BY u.name`,
    [orgs],
  );
  return rows as { organization_id: string; id: string; name: string }[];
}
async function ownerAllowed(c: PoolClient, org: string, owner: string | null) {
  if (!owner) return;
  const team = await teamOf(c, [org]);
  if (!team.some((m) => m.id === owner))
    throw new HttpError(422, "OWNER_NOT_ON_TEAM");
}
const today = () => new Date().toISOString().slice(0, 10);

export const prospectFilters = z
  .object({
    q: z.string().trim().max(100).optional(),
    stage: z.enum(prospectStages).optional(),
    owner: z.union([z.literal("me"), z.uuid()]).optional(),
    follow_up: z.enum(["overdue", "today", "week"]).optional(),
  })
  .strict();
export function parseProspectFilters(params: URLSearchParams) {
  return prospectFilters.parse({
    q: params.get("q") ?? undefined,
    stage: params.get("stage") ?? undefined,
    owner: params.get("owner") ?? undefined,
    follow_up: params.get("follow_up") ?? undefined,
  });
}

const limit = 500;
export async function listProspects(user: string, params: URLSearchParams) {
  const f = parseProspectFilters(params);
  const orgs = await staffOrganizations(pool, user);
  const now = today();
  const where = ["p.organization_id=ANY($1::uuid[])", "p.archived_at IS NULL"];
  const values: unknown[] = [orgs];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("$?", "$" + values.length));
  };
  if (f.q) {
    const escaped = f.q.replace(/[\\%_]/g, "\\$&");
    add(
      `lower(p.company||' '||p.contact_name||' '||p.email||' '||p.phone||' '||p.usdot) LIKE '%'||lower($?::text)||'%'`,
      escaped,
    );
  }
  if (f.stage) add("p.stage=$?", f.stage);
  if (f.owner) add("p.owner_id=$?", f.owner === "me" ? user : f.owner);
  if (f.follow_up) {
    values.push(now);
    const d = "$" + values.length + "::date";
    where.push(
      f.follow_up === "overdue"
        ? `p.next_follow_up_on<${d}`
        : f.follow_up === "today"
          ? `p.next_follow_up_on=${d}`
          : `p.next_follow_up_on BETWEEN ${d} AND ${d}+7`,
    );
  }
  const [rows, counts, due, team, names] = await Promise.all([
    pool.query(
      `${SELECT} WHERE ${where.join(" AND ")}
      ORDER BY p.next_follow_up_on NULLS LAST,lower(p.company),p.id LIMIT ${limit + 1}`,
      values,
    ),
    pool.query(
      `SELECT stage,count(*)::int AS n FROM prospects
      WHERE organization_id=ANY($1::uuid[]) AND archived_at IS NULL GROUP BY stage`,
      [orgs],
    ),
    pool.query(
      `SELECT
        count(*) FILTER (WHERE next_follow_up_on<$2::date)::int AS overdue,
        count(*) FILTER (WHERE next_follow_up_on=$2::date)::int AS today,
        count(*) FILTER (WHERE next_follow_up_on BETWEEN $2::date AND $2::date+7)::int AS week
      FROM prospects WHERE organization_id=ANY($1::uuid[]) AND archived_at IS NULL
        AND stage NOT IN ('won','lost')`,
      [orgs, now],
    ),
    teamOf(pool, orgs),
    pool.query("SELECT id,name FROM organizations WHERE id=ANY($1::uuid[])", [
      orgs,
    ]),
  ]);
  const byStage = Object.fromEntries(
    prospectStages.map((s) => [s, 0]),
  ) as ProspectList["counts"];
  for (const r of counts.rows) byStage[r.stage as keyof typeof byStage] = r.n;
  return {
    prospects: rows.rows.slice(0, limit).map(shape),
    counts: byStage,
    follow_ups: due.rows[0],
    team: team.map((m) => ({
      id: m.id,
      name: m.name,
      organization_id: m.organization_id,
    })),
    organizations: names.rows,
    truncated: rows.rows.length > limit,
    today: now,
  } satisfies ProspectList;
}

async function lockProspect(c: PoolClient, user: string, id: string) {
  const orgs = await staffOrganizations(c, user);
  const { rows } = await c.query(
    "SELECT * FROM prospects WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
    [id],
  );
  const prospect = rows[0];
  if (!prospect || !orgs.includes(prospect.organization_id))
    throw new HttpError(404, "NOT_FOUND");
  return prospect;
}
const audit = (c: PoolClient, user: string, action: string, id: string) =>
  c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    action,
    id,
  ]);
const note = (
  c: PoolClient,
  p: { id: string; organization_id: string },
  user: string,
  kind: string,
  body: string,
  key: string | null = null,
  hash: string | null = null,
) =>
  c.query(
    `INSERT INTO prospect_activities(id,prospect_id,organization_id,kind,body,actor_id,idempotency_key,request_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), p.id, p.organization_id, kind, body, user, key, hash],
  );

export async function getProspect(
  user: string,
  id: string,
): Promise<ProspectDetail> {
  const orgs = await staffOrganizations(pool, user);
  const { rows } = await pool.query(
    `${SELECT} WHERE p.id=$1 AND p.archived_at IS NULL AND p.organization_id=ANY($2::uuid[])`,
    [id, orgs],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  const activities = await pool.query(
    `SELECT a.id,a.kind,a.body,a.created_at,u.name AS actor_name FROM prospect_activities a
    JOIN users u ON u.id=a.actor_id WHERE a.prospect_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 200`,
    [id],
  );
  return {
    prospect: shape(rows[0]),
    activities: activities.rows.map(
      (a): ProspectActivity => ({
        id: a.id,
        kind: a.kind,
        body: a.body,
        actor_name: a.actor_name,
        created_at: a.created_at.toISOString(),
      }),
    ),
  };
}

export async function createProspect(user: string, input: unknown) {
  const data = prospectFields
    .extend({
      idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
      organization_id: z.uuid().optional(),
    })
    .parse(input);
  const { idempotency_key, organization_id, ...fields } = data;
  const hash = digest(JSON.stringify({ ...fields, organization_id }));
  return transaction(async (c) => {
    const orgs = await staffOrganizations(c, user);
    const org = organization_id ?? orgs[0];
    if (!orgs.includes(org)) throw new HttpError(404, "NOT_FOUND");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":prospect:" + idempotency_key,
    ]);
    const old = await c.query(
      "SELECT id,version,request_hash FROM prospects WHERE created_by=$1 AND idempotency_key=$2",
      [user, idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return {
        id: old.rows[0].id as string,
        version: old.rows[0].version as number,
      };
    }
    await ownerAllowed(c, org, fields.owner_id);
    const id = randomUUID();
    await c.query(
      `INSERT INTO prospects(id,organization_id,company,contact_name,email,phone,usdot,truck_count,source,owner_id,next_follow_up_on,notes,created_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        org,
        fields.company,
        fields.contact_name,
        fields.email,
        fields.phone,
        fields.usdot,
        fields.truck_count,
        fields.source,
        fields.owner_id,
        fields.next_follow_up_on,
        fields.notes,
        user,
        idempotency_key,
        hash,
      ],
    );
    await audit(c, user, "prospect.created", id);
    return { id, version: 1 };
  });
}

export async function updateProspect(user: string, id: string, input: unknown) {
  const data = prospectFields
    .extend({ version: z.number().int().positive() })
    .parse(input);
  const { version, ...fields } = data;
  return transaction(async (c) => {
    const current = await lockProspect(c, user, id);
    if (current.version !== version)
      throw new HttpError(409, "VERSION_CONFLICT");
    await ownerAllowed(c, current.organization_id, fields.owner_id);
    await c.query(
      `UPDATE prospects SET company=$2,contact_name=$3,email=$4,phone=$5,usdot=$6,truck_count=$7,
      source=$8,owner_id=$9,next_follow_up_on=$10,notes=$11,version=version+1,updated_at=now() WHERE id=$1`,
      [
        id,
        fields.company,
        fields.contact_name,
        fields.email,
        fields.phone,
        fields.usdot,
        fields.truck_count,
        fields.source,
        fields.owner_id,
        fields.next_follow_up_on,
        fields.notes,
      ],
    );
    await audit(c, user, "prospect.updated", id);
    return { id, version: version + 1 };
  });
}

export async function moveProspect(user: string, id: string, input: unknown) {
  const data = z
    .object({
      stage: z.enum(prospectStages),
      lost_reason: optional(300),
      version: z.number().int().positive(),
    })
    .strict()
    .refine((d) => d.stage !== "lost" || d.lost_reason !== "", {
      message: "Say why this prospect was lost",
      path: ["lost_reason"],
    })
    .parse(input);
  return transaction(async (c) => {
    const current = await lockProspect(c, user, id);
    if (current.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    // A prospect that became a carrier keeps that outcome.
    if (current.carrier_id && data.stage !== "won")
      throw new HttpError(409, "ALREADY_A_CARRIER");
    if (current.stage === data.stage)
      return { id, version: current.version as number };
    await c.query(
      `UPDATE prospects SET stage=$2,lost_reason=$3,stage_changed_at=now(),
      -- A finished prospect has nothing left to follow up.
      next_follow_up_on=CASE WHEN $2 IN ('won','lost') THEN NULL ELSE next_follow_up_on END,
      version=version+1,updated_at=now() WHERE id=$1`,
      [id, data.stage, data.stage === "lost" ? data.lost_reason : ""],
    );
    await note(
      c,
      current,
      user,
      "stage",
      `${current.stage} → ${data.stage}${data.stage === "lost" ? `: ${data.lost_reason}` : ""}`,
    );
    await audit(c, user, "prospect.stage_changed", id);
    return { id, version: data.version + 1 };
  });
}

export async function logActivity(user: string, id: string, input: unknown) {
  const data = z
    .object({
      kind: z.enum(activityKinds),
      body: text(2000),
      // Logging a call usually ends with "call again on …".
      next_follow_up_on: date.nullable().optional(),
      idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
    })
    .strict()
    .parse(input);
  const hash = digest(
    JSON.stringify({
      id,
      kind: data.kind,
      body: data.body,
      next: data.next_follow_up_on ?? null,
    }),
  );
  return transaction(async (c) => {
    const current = await lockProspect(c, user, id);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":prospect-activity:" + data.idempotency_key,
    ]);
    const old = await c.query(
      "SELECT request_hash FROM prospect_activities WHERE actor_id=$1 AND idempotency_key=$2",
      [user, data.idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { ok: true, version: current.version as number };
    }
    await note(
      c,
      current,
      user,
      data.kind,
      data.body,
      data.idempotency_key,
      hash,
    );
    // Activity does not bump the version: it never conflicts with an edit.
    if (data.next_follow_up_on !== undefined)
      await c.query(
        "UPDATE prospects SET next_follow_up_on=$2,version=version+1,updated_at=now() WHERE id=$1",
        [id, data.next_follow_up_on],
      );
    else
      await c.query("UPDATE prospects SET updated_at=now() WHERE id=$1", [id]);
    await audit(c, user, "prospect.activity_logged", id);
    const { rows } = await c.query(
      "SELECT version FROM prospects WHERE id=$1",
      [id],
    );
    return { ok: true, version: rows[0].version as number };
  });
}

export async function archiveProspect(
  user: string,
  id: string,
  input: unknown,
) {
  const data = z
    .object({ version: z.number().int().positive() })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    const current = await lockProspect(c, user, id);
    if (current.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    await c.query(
      "UPDATE prospects SET archived_at=now(),version=version+1 WHERE id=$1",
      [id],
    );
    await audit(c, user, "prospect.archived", id);
    return { ok: true };
  });
}

/**
 * Starts carrier setup for a prospect that agreed to work with us. This only
 * creates the carrier record and its setup profile (the same as adding a
 * carrier by hand). It books nothing and grants no authority: freight still
 * needs a verified, written dispatch authorization (Phase 1 rule).
 */
export async function convertProspect(
  user: string,
  id: string,
  input: unknown,
) {
  const data = z
    .object({ version: z.number().int().positive() })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    const current = await lockProspect(c, user, id);
    // Repeating the request returns the carrier already created.
    if (current.carrier_id) return { carrier_id: current.carrier_id as string };
    if (current.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (current.stage === "lost") throw new HttpError(409, "PROSPECT_LOST");
    if (!current.contact_name || !current.email)
      throw new HttpError(422, "CONTACT_NAME_AND_EMAIL_REQUIRED");
    const carrierId = randomUUID();
    await c.query("INSERT INTO carriers VALUES($1,$2,$3)", [
      carrierId,
      current.organization_id,
      current.company,
    ]);
    await c.query("INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)", [
      user,
      carrierId,
    ]);
    await c.query(
      "INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone,usdot) VALUES($1,$2,$3,$4,$5)",
      [
        carrierId,
        current.contact_name,
        current.email,
        current.phone,
        current.usdot,
      ],
    );
    await emit(c, user, carrierId, "carrier.created", { prospect_id: id });
    await c.query(
      `UPDATE prospects SET stage='won',lost_reason='',carrier_id=$2,next_follow_up_on=NULL,
      stage_changed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,
      [id, carrierId],
    );
    await note(c, current, user, "converted", "Carrier setup started");
    await audit(c, user, "prospect.converted", id);
    return { carrier_id: carrierId };
  });
}
