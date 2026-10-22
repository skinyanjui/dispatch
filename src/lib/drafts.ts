import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError } from "./auth";
import { detail } from "./loads";
import { formatMoney } from "./entry";

/**
 * Document templates and drafts (ADR 0040). A template is plain text with
 * {{merge fields}}; a draft is that text filled in from one record the person
 * can already see. Filling is a plain lookup (no code runs, no model is
 * involved); the assistant only chooses the template and record. Drafts are
 * for review and copying: nothing is sent, booked or invoiced.
 */
export const targets = ["load", "carrier", "contact"] as const;
export type Target = (typeof targets)[number];

export const mergeFields: Record<Target, Record<string, string>> = {
  load: {
    "load.reference": "Load reference",
    "load.carrier": "Carrier name",
    "load.stage": "Stage",
    "load.rate": "Agreed rate",
    "load.pickup": "Pickup address",
    "load.delivery": "Delivery address",
    "load.next_appointment": "Next appointment",
    "load.driver": "Assigned driver",
  },
  carrier: {
    "carrier.name": "Carrier name",
    "carrier.contact": "Contact name",
    "carrier.email": "Contact email",
    "carrier.phone": "Phone",
  },
  contact: {
    "contact.name": "Contact name",
    "contact.company": "Company",
    "contact.email": "Email",
    "contact.phone": "Phone",
  },
};
const common: Record<string, string> = {
  "sender.name": "Your name",
  today: "Today's date",
};
export const allFields = (t: Target) => ({ ...mergeFields[t], ...common });

const FIELD = /\{\{\s*([a-z_.]+)\s*\}\}/g;
/** Fields in a body that this target does not offer. */
export const unknownFields = (target: Target, body: string) =>
  [...body.matchAll(FIELD)]
    .map((m) => m[1])
    .filter((f) => !(f in allFields(target)));

const templateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    target: z.enum(targets),
    body: z.string().trim().min(1).max(8000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const bad = unknownFields(v.target, v.body);
    if (bad.length)
      ctx.addIssue({
        code: "custom",
        message: "Unknown merge fields: " + [...new Set(bad)].join(", "),
        path: ["body"],
      });
  });
const templatePatch = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(80).optional(),
    body: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();
const generateSchema = z
  .object({
    template_id: z.uuid(),
    target_id: z.uuid(),
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
  })
  .strict();

/** The organization a person works for as staff (owner, admin or dispatcher). */
export async function staffOrganization(user: string) {
  // Same choice the assistant makes, so a template made here is the one it sees:
  // the organization they administer first, else one they dispatch for.
  const admin = await pool.query(
    "SELECT organization_id FROM organization_members WHERE user_id=$1 ORDER BY created_at,organization_id LIMIT 1",
    [user],
  );
  if (admin.rows[0]) return admin.rows[0].organization_id as string;
  const { rows } = await pool.query(
    `SELECT c.organization_id FROM carriers c JOIN memberships m ON m.carrier_id=c.id
    WHERE m.user_id=$1 AND m.role='dispatcher' ORDER BY c.organization_id LIMIT 1`,
    [user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0].organization_id as string;
}

export async function listTemplates(user: string) {
  const org = await staffOrganization(user);
  const { rows } = await pool.query(
    `SELECT id,name,target,body,version,updated_at FROM document_templates
    WHERE organization_id=$1 AND archived_at IS NULL ORDER BY lower(name),id`,
    [org],
  );
  return {
    templates: rows,
    fields: Object.fromEntries(targets.map((t) => [t, allFields(t)])),
  };
}

export async function createTemplate(user: string, input: unknown) {
  const data = templateSchema.parse(input);
  const org = await staffOrganization(user);
  try {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO document_templates(id,organization_id,name,target,body,created_by)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [id, org, data.name, data.target, data.body, user],
    );
    await pool.query(
      "INSERT INTO audit_logs VALUES($1,$2,'template.created',$3,now())",
      [randomUUID(), user, id],
    );
    return { id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new HttpError(409, "TEMPLATE_NAME_TAKEN");
    throw e;
  }
}

export async function updateTemplate(user: string, id: string, input: unknown) {
  const data = templatePatch.parse(input);
  const org = await staffOrganization(user);
  const found = await pool.query(
    "SELECT target,version FROM document_templates WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL",
    [id, org],
  );
  if (!found.rows[0]) throw new HttpError(404, "NOT_FOUND");
  if (found.rows[0].version !== data.version)
    throw new HttpError(409, "VERSION_CONFLICT");
  if (data.body) {
    const bad = unknownFields(found.rows[0].target, data.body);
    if (bad.length) throw new HttpError(422, "UNKNOWN_MERGE_FIELD");
  }
  try {
    await pool.query(
      `UPDATE document_templates SET name=COALESCE($3,name),body=COALESCE($4,body),
      version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2`,
      [id, org, data.name ?? null, data.body ?? null],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new HttpError(409, "TEMPLATE_NAME_TAKEN");
    throw e;
  }
  await pool.query(
    "INSERT INTO audit_logs VALUES($1,$2,'template.updated',$3,now())",
    [randomUUID(), user, id],
  );
  return { ok: true };
}

export async function archiveTemplate(user: string, id: string) {
  const org = await staffOrganization(user);
  const r = await pool.query(
    "UPDATE document_templates SET archived_at=now() WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL",
    [id, org],
  );
  if (!r.rowCount) throw new HttpError(404, "NOT_FOUND");
  await pool.query(
    "INSERT INTO audit_logs VALUES($1,$2,'template.archived',$3,now())",
    [randomUUID(), user, id],
  );
  return { ok: true };
}

/** Values for one record, resolved only through what this person may read. */
async function recordValues(
  user: string,
  org: string,
  target: Target,
  id: string,
): Promise<{ label: string; values: Record<string, string> }> {
  if (target === "load") {
    let load;
    try {
      load = await detail(user, id);
    } catch {
      throw new HttpError(404, "NOT_FOUND");
    }
    const carrier = await pool.query(
      "SELECT name,organization_id FROM carriers WHERE id=$1",
      [load.carrier_id],
    );
    if (carrier.rows[0]?.organization_id !== org)
      throw new HttpError(404, "NOT_FOUND");
    const stops = load.stops as {
      kind: string;
      address: string;
      window_start: string;
      timezone: string;
    }[];
    const next = (
      load as {
        summary?: {
          next?: { label: string; window_start: string; timezone: string };
        };
      }
    ).summary?.next;
    const first = stops[0],
      last = stops[stops.length - 1];
    return {
      label: load.reference,
      values: {
        "load.reference": load.reference,
        "load.carrier": carrier.rows[0].name,
        "load.stage": load.cancelled_at ? "cancelled" : load.stage,
        "load.rate": formatMoney(load.amount_minor),
        "load.pickup": first?.address ?? "",
        "load.delivery": last?.address ?? "",
        "load.next_appointment": next
          ? `${next.label} ${new Date(next.window_start).toLocaleString("en-US", { timeZone: next.timezone, dateStyle: "medium", timeStyle: "short" })}`
          : "",
        "load.driver": load.assignment?.name ?? "",
      },
    };
  }
  if (target === "carrier") {
    const { rows } = await pool.query(
      `SELECT c.name,p.contact_name,p.contact_email,p.phone FROM carriers c
      LEFT JOIN carrier_profiles p ON p.carrier_id=c.id
      WHERE c.id=$1 AND c.organization_id=$2 AND (
        EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=c.id AND m.user_id=$3 AND m.role='dispatcher')
        OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=c.organization_id AND om.user_id=$3))`,
      [id, org, user],
    );
    if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
    return {
      label: rows[0].name,
      values: {
        "carrier.name": rows[0].name,
        "carrier.contact": rows[0].contact_name ?? "",
        "carrier.email": rows[0].contact_email ?? "",
        "carrier.phone": rows[0].phone ?? "",
      },
    };
  }
  const { rows } = await pool.query(
    "SELECT name,company,email,phone FROM contacts WHERE id=$1 AND organization_id=$2",
    [id, org],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return {
    label: rows[0].name,
    values: {
      "contact.name": rows[0].name,
      "contact.company": rows[0].company,
      "contact.email": rows[0].email,
      "contact.phone": rows[0].phone,
    },
  };
}

/** Fills a body. Empty values stay visible as [missing: field] for the reviewer. */
export function render(body: string, values: Record<string, string>) {
  const missing: string[] = [];
  const text = body.replace(FIELD, (_, field: string) => {
    const v = values[field];
    if (v === undefined || v === "") {
      if (!missing.includes(field)) missing.push(field);
      return `[missing: ${field}]`;
    }
    return v;
  });
  return { text, missing };
}

export async function generateDraft(
  user: string,
  input: unknown,
  source: "person" | "assistant" = "person",
  organization?: string,
) {
  const data = generateSchema.parse(input);
  const org = organization ?? (await staffOrganization(user));
  // The caller must be staff of that organization (assistant calls pass it).
  const staff = await pool.query(
    `SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2
    UNION SELECT 1 FROM carriers c JOIN memberships m ON m.carrier_id=c.id
      WHERE c.organization_id=$1 AND m.user_id=$2 AND m.role='dispatcher' LIMIT 1`,
    [org, user],
  );
  if (!staff.rowCount) throw new HttpError(404, "NOT_FOUND");
  const tpl = await pool.query(
    "SELECT id,name,target,body FROM document_templates WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL",
    [data.template_id, org],
  );
  if (!tpl.rows[0]) throw new HttpError(404, "NOT_FOUND");
  const target = tpl.rows[0].target as Target;
  const sender = await pool.query("SELECT name FROM users WHERE id=$1", [user]);
  const record = await recordValues(user, org, target, data.target_id);
  const { text, missing } = render(tpl.rows[0].body, {
    ...record.values,
    "sender.name": sender.rows[0].name,
    today: new Date().toLocaleDateString("en-US", { dateStyle: "long" }),
  });
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":draft:" + data.idempotency_key,
    ]);
    const old = await c.query(
      "SELECT id,template_id,target_id FROM document_drafts WHERE created_by=$1 AND idempotency_key=$2",
      [user, data.idempotency_key],
    );
    if (old.rows[0]) {
      if (
        old.rows[0].template_id !== data.template_id ||
        old.rows[0].target_id !== data.target_id
      )
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { id: old.rows[0].id as string, missing };
    }
    const id = randomUUID();
    await c.query(
      `INSERT INTO document_drafts(id,organization_id,template_id,template_name,target,target_id,target_label,body,missing,source,created_by,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        org,
        data.template_id,
        tpl.rows[0].name,
        target,
        data.target_id,
        record.label,
        text,
        missing,
        source,
        user,
        data.idempotency_key,
      ],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      source === "assistant" ? "draft.generated.assistant" : "draft.generated",
      id,
    ]);
    return { id, missing };
  });
}

export async function listDrafts(user: string, params: URLSearchParams) {
  const org = await staffOrganization(user);
  const status = z
    .enum(["draft", "approved", "discarded"])
    .optional()
    .parse(params.get("status") ?? undefined);
  const { rows } = await pool.query(
    `SELECT d.id,d.template_name,d.target,d.target_id,d.target_label,d.body,d.missing,d.source,d.status,d.created_at,d.decided_at,
      u.name created_by_name
    FROM document_drafts d JOIN users u ON u.id=d.created_by
    WHERE d.organization_id=$1 AND ($2::text IS NULL OR d.status=$2)
    ORDER BY d.created_at DESC,d.id DESC LIMIT 100`,
    [org, status ?? null],
  );
  return { drafts: rows };
}

export async function decideDraft(
  user: string,
  id: string,
  decision: "approved" | "discarded",
) {
  const org = await staffOrganization(user);
  const r = await pool.query(
    `UPDATE document_drafts SET status=$3,decided_by=$4,decided_at=now()
    WHERE id=$1 AND organization_id=$2 AND status='draft'`,
    [id, org, decision, user],
  );
  if (!r.rowCount) {
    const exists = await pool.query(
      "SELECT status FROM document_drafts WHERE id=$1 AND organization_id=$2",
      [id, org],
    );
    if (!exists.rows[0]) throw new HttpError(404, "NOT_FOUND");
    throw new HttpError(409, "ALREADY_DECIDED");
  }
  await pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    decision === "approved" ? "draft.approved" : "draft.discarded",
    id,
  ]);
  return { ok: true };
}
