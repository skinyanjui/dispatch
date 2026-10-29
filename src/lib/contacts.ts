import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { requestContactChange } from "./change-control";
import {
  contactKinds,
  type ContactKind,
  type DirectoryEntry,
  type DirectoryGroup,
} from "./contact-types";

/**
 * Directory access (ADR 0017), by the caller's own memberships:
 * - dispatchers: team, drivers and company contacts of their carriers, plus
 *   every external contact of their organization;
 * - carrier managers: dispatchers, managers and drivers of their carrier, and
 *   external contacts linked to that carrier;
 * - drivers: only the dispatchers and managers of their carrier.
 * Organization administrators also see their organization's external
 * contacts. Nobody sees themselves. Foreign records never appear.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.union([z.email(), z.literal("")]))
  .transform((v) => v.toLowerCase());

export const contactFields = z
  .object({
    kind: z.enum(contactKinds),
    name: text(160),
    company: z.string().trim().max(160).default(""),
    email: email.default(""),
    phone: z.string().trim().max(40).default(""),
    notes: z.string().trim().max(1000).default(""),
    carrier_id: z.uuid().nullable().default(null),
    // Recorded only when the contact actually agreed to receive texts.
    sms_consent: z.boolean().default(false),
    sms_consent_note: z.string().trim().max(300).default(""),
  })
  .strict()
  .refine((d) => d.email !== "" || d.phone !== "", {
    message: "Add an email address or a phone number",
    path: ["email"],
  })
  .refine(
    (d) => !d.sms_consent || (d.phone !== "" && d.sms_consent_note !== ""),
    {
      message: "Record their phone number and how they agreed to texts",
      path: ["sms_consent_note"],
    },
  );

type Access = {
  dispatchCarriers: string[];
  managerCarriers: string[];
  driverCarriers: string[];
  organizations: string[]; // organizations with dispatcher or admin access
};
export async function access(
  c: PoolClient | typeof pool,
  user: string,
): Promise<Access> {
  const memberships = await c.query(
    "SELECT carrier_id,role FROM memberships WHERE user_id=$1",
    [user],
  );
  const orgs = await c.query(
    `SELECT DISTINCT organization_id FROM (
      SELECT c.organization_id FROM carriers c JOIN memberships m ON m.carrier_id=c.id
        WHERE m.user_id=$1 AND m.role='dispatcher'
      UNION SELECT organization_id FROM organization_members WHERE user_id=$1) o`,
    [user],
  );
  const by = (role: string) =>
    memberships.rows
      .filter((m) => m.role === role)
      .map((m) => m.carrier_id as string);
  return {
    dispatchCarriers: by("dispatcher"),
    managerCarriers: by("carrier-manager"),
    driverCarriers: by("driver"),
    organizations: orgs.rows.map((r) => r.organization_id as string),
  };
}

const digitsOf = (value: string) => value.replace(/\D/g, "");
/** SQL fragment: name/company/email/phone contains the term, phones by digits. */
const match = (columns: string[], q: string | null) =>
  q
    ? `AND (lower(${columns.map((c) => `coalesce(${c},'')`).join(`||' '||`)}) LIKE '%'||lower($Q::text)||'%'
      OR ($D::text<>'' AND regexp_replace(coalesce(${columns[columns.length - 1]},''),'\\D','','g') LIKE '%'||$D::text||'%'))`
    : "";

export const directoryFilters = z
  .object({
    q: z.string().trim().max(100).optional(),
    group: z.enum(["team", "driver", "carrier", "external"]).optional(),
    kind: z.enum(contactKinds).optional(),
    carrier_id: z.uuid().optional(),
    favorites: z.enum(["true", "false"]).optional(),
  })
  .strict();

export function parseDirectoryFilters(params: URLSearchParams) {
  return directoryFilters.parse({
    q: params.get("q") ?? undefined,
    group: params.get("group") ?? undefined,
    kind: params.get("kind") ?? undefined,
    carrier_id: params.get("carrier_id") ?? undefined,
    favorites: params.get("favorites") ?? undefined,
  });
}

/** Every entry the caller may see that matches the filters, unpaged. */
export async function collect(
  user: string,
  f: z.infer<typeof directoryFilters>,
) {
  const a = await access(pool, user);
  const q = f.q || null;
  const digits = q ? digitsOf(q) : null;
  const entries = new Map<string, DirectoryEntry>();
  const add = (e: DirectoryEntry) => {
    const existing = entries.get(e.key);
    if (!existing) entries.set(e.key, e);
    else
      for (const carrier of e.carriers)
        if (!existing.carriers.some((c) => c.id === carrier.id))
          existing.carriers.push(carrier);
  };
  const run = (sql: string, base: unknown[]) => {
    const withQ = sql
      .replace(/\$Q/g, () => "$" + (base.length + 1))
      .replace(/\$D/g, () => "$" + (base.length + 2));
    const values = [...base];
    // Escape LIKE wildcards so a typed "%" or "_" matches literally.
    if (q)
      values.push(
        q.replace(/[\\%_]/g, (m) => "\\" + m),
        digits && digits.length >= 3 ? digits : "",
      );
    return pool.query(withQ, values);
  };
  const visibleCarriers = [
    ...new Set([
      ...a.dispatchCarriers,
      ...a.managerCarriers,
      ...a.driverCarriers,
    ]),
  ];

  if (!f.group || f.group === "team") {
    const rows = await run(
      `SELECT u.id,u.name,u.email,u.phone,u.sms_opt_in_at,m.role,c.id carrier_id,c.name carrier_name
      FROM memberships m JOIN users u ON u.id=m.user_id JOIN carriers c ON c.id=m.carrier_id
      WHERE m.carrier_id=ANY($1::uuid[]) AND m.role IN ('dispatcher','carrier-manager') AND u.id<>$2
      ${match(["u.name", "u.email", "u.phone"], q)}`,
      [visibleCarriers, user],
    );
    for (const r of rows.rows)
      add({
        key: "user:" + r.id,
        group: "team",
        name: r.name,
        detail: r.role === "dispatcher" ? "Dispatcher" : "Carrier manager",
        carriers: [{ id: r.carrier_id, name: r.carrier_name }],
        email: r.email,
        phone: r.phone,
        favorite: false,
        sms_ok: r.sms_opt_in_at !== null,
      });
  }
  const seesDrivers = [...a.dispatchCarriers, ...a.managerCarriers];
  if ((!f.group || f.group === "driver") && seesDrivers.length) {
    const rows = await run(
      `SELECT d.id,d.name,d.onboarding_status,c.id carrier_id,c.name carrier_name,
        COALESCE(NULLIF(d.contact_email,''),u.email,'') email,COALESCE(NULLIF(d.phone,''),u.phone,'') phone,
        u.sms_opt_in_at
      FROM drivers d JOIN carriers c ON c.id=d.carrier_id
      LEFT JOIN memberships mm ON mm.driver_id=d.id LEFT JOIN users u ON u.id=mm.user_id
      WHERE d.carrier_id=ANY($1::uuid[]) AND d.onboarding_status<>'removed' AND (u.id IS NULL OR u.id<>$2)
      ${match(["d.name", "COALESCE(NULLIF(d.contact_email,''),u.email,'')", "COALESCE(NULLIF(d.phone,''),u.phone,'')"], q)}`,
      [seesDrivers, user],
    );
    for (const r of rows.rows)
      add({
        key: "driver:" + r.id,
        group: "driver",
        name: r.name,
        detail:
          r.onboarding_status === "pending" ? "Driver · invited" : "Driver",
        carriers: [{ id: r.carrier_id, name: r.carrier_name }],
        email: r.email,
        phone: r.phone,
        favorite: false,
        sms_ok: r.sms_opt_in_at !== null,
      });
  }
  if ((!f.group || f.group === "carrier") && a.dispatchCarriers.length) {
    const rows = await run(
      `SELECT c.id,c.name,p.contact_name,p.contact_email email,p.phone
      FROM carriers c JOIN carrier_profiles p ON p.carrier_id=c.id
      WHERE c.id=ANY($1::uuid[])
      ${match(["c.name", "p.contact_name", "p.contact_email", "p.phone"], q)}`,
      [a.dispatchCarriers],
    );
    for (const r of rows.rows)
      add({
        key: "carrier:" + r.id,
        group: "carrier",
        name: r.name,
        detail: "Carrier · " + r.contact_name,
        carriers: [{ id: r.id, name: r.name }],
        email: r.email,
        phone: r.phone,
        favorite: false,
        sms_ok: false,
      });
  }
  if (
    (!f.group || f.group === "external") &&
    (a.organizations.length || a.managerCarriers.length)
  ) {
    const rows = await run(
      `SELECT x.*,c.name carrier_name FROM contacts x LEFT JOIN carriers c ON c.id=x.carrier_id
      WHERE x.archived_at IS NULL
        AND (x.organization_id=ANY($1::uuid[]) OR x.carrier_id=ANY($2::uuid[]))
        ${f.kind ? "AND x.kind='" + f.kind + "'" : ""}
      ${match(["x.name", "x.company", "x.email", "x.phone"], q)}`,
      [a.organizations, a.managerCarriers],
    );
    for (const r of rows.rows) {
      const editable =
        a.organizations.includes(r.organization_id) ||
        (r.carrier_id !== null && a.managerCarriers.includes(r.carrier_id));
      add({
        key: "contact:" + r.id,
        group: "external",
        name: r.name,
        detail: [r.company, r.kind[0].toUpperCase() + r.kind.slice(1)]
          .filter(Boolean)
          .join(" · "),
        carriers: r.carrier_id
          ? [{ id: r.carrier_id, name: r.carrier_name }]
          : [],
        email: r.email,
        phone: r.phone,
        notes: r.notes,
        favorite: false,
        sms_ok: r.sms_consent_at !== null,
        contact: {
          id: r.id,
          kind: r.kind as ContactKind,
          company: r.company,
          carrier_id: r.carrier_id,
          version: r.version,
          editable,
          sms_consent_note: r.sms_consent_note,
        },
      });
    }
  }
  const favorites = new Set(
    (
      await pool.query(
        "SELECT ref_key FROM contact_favorites WHERE user_id=$1",
        [user],
      )
    ).rows.map((r) => r.ref_key as string),
  );
  let list = [...entries.values()].map((e) => ({
    ...e,
    favorite: favorites.has(e.key),
  }));
  if (f.carrier_id)
    list = list.filter((e) => e.carriers.some((c) => c.id === f.carrier_id));
  if (f.favorites === "true") list = list.filter((e) => e.favorite);
  const order: Record<DirectoryGroup, number> = {
    team: 0,
    driver: 1,
    carrier: 2,
    external: 3,
  };
  list.sort(
    (x, y) =>
      Number(y.favorite) - Number(x.favorite) ||
      order[x.group] - order[y.group] ||
      x.name.localeCompare(y.name) ||
      x.key.localeCompare(y.key),
  );
  return { list, access: a, visibleCarriers };
}
export async function directory(user: string, params: URLSearchParams) {
  const {
    list,
    access: a,
    visibleCarriers,
  } = await collect(user, parseDirectoryFilters(params));
  const filters = parseDirectoryFilters(params);
  // Unfiltered, each group is capped so a big roster never hides a whole
  // category (brokers sort after drivers); favorites always show. Choosing a
  // group lifts the cap to 100.
  const perGroup = filters.group ? 100 : 25;
  const seen: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const e of list) totals[e.group] = (totals[e.group] ?? 0) + 1;
  const entries = list.filter((e) => {
    seen[e.group] = (seen[e.group] ?? 0) + 1;
    return e.favorite || seen[e.group] <= perGroup;
  });
  const more = Object.fromEntries(
    Object.entries(totals).filter(
      ([g, n]) => n > entries.filter((e) => e.group === g).length,
    ),
  ) as Partial<Record<DirectoryGroup, number>>;
  return {
    entries,
    truncated: Object.keys(more).length > 0,
    more,
    can_add: a.organizations.length > 0 || a.managerCarriers.length > 0,
    carriers: await visibleCarrierNames(visibleCarriers),
    manager_carriers: a.managerCarriers,
    organizations: a.organizations,
  };
}
async function visibleCarrierNames(ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    "SELECT id,name,organization_id FROM carriers WHERE id=ANY($1::uuid[]) ORDER BY name",
    [ids],
  );
  return rows as { id: string; name: string; organization_id: string }[];
}

// ---------- External contacts ----------

/** Which organization a new or changed contact may belong to, and its carrier. */
async function writeScope(
  c: PoolClient,
  user: string,
  carrierId: string | null,
  organizationId?: string,
) {
  const a = await access(c, user);
  if (carrierId) {
    const carrier = await c.query(
      "SELECT organization_id FROM carriers WHERE id=$1",
      [carrierId],
    );
    const org = carrier.rows[0]?.organization_id as string | undefined;
    const allowed =
      (org && a.organizations.includes(org)) ||
      a.managerCarriers.includes(carrierId);
    if (!org || !allowed) throw new HttpError(404, "NOT_FOUND");
    return org;
  }
  // Without a carrier link only organization staff may add the contact.
  const org = organizationId ?? a.organizations[0];
  if (!org || !a.organizations.includes(org))
    throw new HttpError(404, "NOT_FOUND");
  return org;
}

export async function createContact(user: string, input: unknown) {
  const data = contactFields
    .extend({
      idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
      organization_id: z.uuid().optional(),
    })
    .parse(input);
  const { idempotency_key, organization_id, ...fields } = data;
  const hash = digest(JSON.stringify(fields));
  return transaction(async (c) => {
    const org = await writeScope(c, user, fields.carrier_id, organization_id);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":contact:" + idempotency_key,
    ]);
    const old = await c.query(
      "SELECT id,version,request_hash FROM contacts WHERE created_by=$1 AND idempotency_key=$2",
      [user, idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { id: old.rows[0].id, version: old.rows[0].version };
    }
    const id = randomUUID();
    await c.query(
      `INSERT INTO contacts(id,organization_id,carrier_id,kind,name,company,email,phone,notes,created_by,idempotency_key,request_hash,sms_consent_at,sms_consent_by,sms_consent_note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $13::boolean THEN now() END,CASE WHEN $13::boolean THEN $10::uuid END,$14)`,
      [
        id,
        org,
        fields.carrier_id,
        fields.kind,
        fields.name,
        fields.company,
        fields.email,
        fields.phone,
        fields.notes,
        user,
        idempotency_key,
        hash,
        fields.sms_consent,
        fields.sms_consent ? fields.sms_consent_note : "",
      ],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'contact.created',$3,now())",
      [randomUUID(), user, id],
    );
    return { id, version: 1 };
  });
}

async function lockContact(c: PoolClient, user: string, id: string) {
  const { rows } = await c.query(
    "SELECT * FROM contacts WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
    [id],
  );
  const contact = rows[0];
  if (!contact) throw new HttpError(404, "NOT_FOUND");
  const a = await access(c, user);
  const allowed =
    a.organizations.includes(contact.organization_id) ||
    (contact.carrier_id !== null &&
      a.managerCarriers.includes(contact.carrier_id));
  if (!allowed) throw new HttpError(404, "NOT_FOUND");
  return contact;
}

export async function updateContact(user: string, id: string, input: unknown) {
  const data = contactFields
    .extend({
      version: z.number().int().positive(),
      // Why a carrier contact's phone or email is changing (ADR 0064).
      change_reason: z.string().trim().max(500).default(""),
    })
    .parse(input);
  const { version, change_reason, ...fields } = data;
  return transaction(async (c) => {
    const current = await lockContact(c, user, id);
    if (current.version !== version)
      throw new HttpError(409, "VERSION_CONFLICT");
    // Moving a contact to another carrier needs access to that carrier too,
    // whether the move applies now or waits for approval.
    if (fields.carrier_id !== current.carrier_id)
      await writeScope(c, user, fields.carrier_id, current.organization_id);
    // A carrier contact's phone, email and carrier link are where impostors
    // redirect calls and paperwork, so changing any of them waits for a second
    // person. Unlinking or moving the contact is held too: otherwise it could be
    // unlinked and its details changed freely. Other fields apply now.
    let held: string | null = null;
    if (
      current.carrier_id &&
      (fields.carrier_id !== current.carrier_id ||
        fields.email !== current.email ||
        fields.phone !== current.phone)
    ) {
      if (!change_reason) throw new HttpError(422, "REASON_REQUIRED");
      held = await requestContactChange(
        c,
        user,
        current,
        {
          email: fields.email,
          phone: fields.phone,
          carrier_id: fields.carrier_id,
        },
        change_reason,
      );
      fields.email = current.email;
      fields.phone = current.phone;
      fields.carrier_id = current.carrier_id;
    }
    await c.query(
      `UPDATE contacts SET kind=$2,name=$3,company=$4,email=$5,phone=$6,notes=$7,carrier_id=$8,
      -- Consent belongs to a phone number: it is kept only while the number
      -- is unchanged, and otherwise must be re-recorded.
      sms_consent_at=CASE WHEN $9::boolean THEN (CASE WHEN sms_consent_at IS NOT NULL AND phone=$6 THEN sms_consent_at ELSE now() END) END,
      sms_consent_by=CASE WHEN $9::boolean THEN (CASE WHEN sms_consent_at IS NOT NULL AND phone=$6 THEN sms_consent_by ELSE $10::uuid END) END,
      sms_consent_note=CASE WHEN $9::boolean THEN $11 ELSE '' END,
      version=version+1,updated_at=now() WHERE id=$1`,
      [
        id,
        fields.kind,
        fields.name,
        fields.company,
        fields.email,
        fields.phone,
        fields.notes,
        fields.carrier_id,
        fields.sms_consent,
        user,
        fields.sms_consent ? fields.sms_consent_note : "",
      ],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'contact.updated',$3,now())",
      [randomUUID(), user, id],
    );
    return held
      ? {
          id,
          version: version + 1,
          pending_approval: true as const,
          change_id: held,
        }
      : { id, version: version + 1 };
  });
}

export async function archiveContact(user: string, id: string, input: unknown) {
  const data = z
    .object({ version: z.number().int().positive() })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    const current = await lockContact(c, user, id);
    if (current.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    await c.query(
      "UPDATE contacts SET archived_at=now(),version=version+1 WHERE id=$1",
      [id],
    );
    await c.query("DELETE FROM contact_favorites WHERE ref_key=$1", [
      "contact:" + id,
    ]);
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'contact.archived',$3,now())",
      [randomUUID(), user, id],
    );
    return { ok: true };
  });
}

// ---------- Favorites ----------

export async function setFavorite(user: string, input: unknown) {
  const data = z
    .object({
      key: z.string().regex(/^(user|driver|carrier|contact):[0-9a-f-]{36}$/),
      favorite: z.boolean(),
    })
    .strict()
    .parse(input);
  if (data.favorite) {
    // Only entries the caller can see may be starred.
    const visible = await collect(user, {});
    if (!visible.list.some((e) => e.key === data.key))
      throw new HttpError(404, "NOT_FOUND");
    await pool.query(
      "INSERT INTO contact_favorites(user_id,ref_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [user, data.key],
    );
  } else
    await pool.query(
      "DELETE FROM contact_favorites WHERE user_id=$1 AND ref_key=$2",
      [user, data.key],
    );
  return { key: data.key, favorite: data.favorite };
}
