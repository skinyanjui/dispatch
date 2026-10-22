import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./db";
import { HttpError } from "./auth";

export const viewFields = [
  "carrier",
  "stage",
  "next",
  "driver",
  "docs",
  "freight",
  "created",
] as const;

export const viewConfigSchema = z
  .object({
    layout: z.enum(["board", "table", "calendar"]),
    group_by: z.enum(["none", "stage", "carrier"]).default("none"),
    sort: z
      .object({
        key: z.enum(["reference", ...viewFields]),
        desc: z.boolean(),
      })
      .default({ key: "created", desc: true }),
    hidden_fields: z
      .array(z.enum(viewFields))
      .max(viewFields.length)
      .default([]),
    compact: z.boolean().default(false),
    calendar_field: z.enum(["next", "created"]).default("next"),
    filters: z
      .object({
        status: z.string().max(20).default(""),
        carrier_id: z.uuid().nullable().default(null),
      })
      .default({ status: "", carrier_id: null }),
  })
  .strict();

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    shared: z.boolean().default(false),
    config: viewConfigSchema,
  })
  .strict();
const patchSchema = bodySchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);

async function organizationOf(user: string) {
  const { rows } = await pool.query(
    "SELECT organization_id FROM organization_members WHERE user_id=$1 ORDER BY organization_id LIMIT 1",
    [user],
  );
  return (rows[0]?.organization_id as string | undefined) ?? null;
}

export async function listViews(user: string) {
  const { rows } = await pool.query(
    `SELECT v.id,v.name,v.shared,v.config,v.version,u.name owner_name,(v.owner_id=$1) mine
    FROM saved_views v JOIN users u ON u.id=v.owner_id
    WHERE v.surface='loads' AND (v.owner_id=$1 OR (v.shared AND v.organization_id IN
      (SELECT organization_id FROM organization_members WHERE user_id=$1)))
    ORDER BY (v.owner_id=$1) DESC,lower(v.name),v.id`,
    [user],
  );
  return { views: rows };
}

export async function createView(user: string, input: unknown) {
  const data = bodySchema.parse(input);
  const org = await organizationOf(user);
  if (data.shared && !org) throw new HttpError(422, "NO_ORGANIZATION");
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO saved_views(id,owner_id,organization_id,surface,name,shared,config)
      VALUES($1,$2,$3,'loads',$4,$5,$6)`,
      [id, user, data.shared ? org : null, data.name, data.shared, data.config],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new HttpError(409, "VIEW_NAME_TAKEN");
    throw e;
  }
  return { id };
}

export async function updateView(user: string, id: string, input: unknown) {
  const data = patchSchema.parse(input);
  const mine = await pool.query(
    "SELECT shared FROM saved_views WHERE id=$1 AND owner_id=$2",
    [id, user],
  );
  if (!mine.rows[0]) throw new HttpError(404, "NOT_FOUND");
  const shared = data.shared ?? mine.rows[0].shared;
  const org = shared ? await organizationOf(user) : null;
  if (shared && !org) throw new HttpError(422, "NO_ORGANIZATION");
  try {
    await pool.query(
      `UPDATE saved_views SET
        name=COALESCE($3,name),
        shared=$4,
        organization_id=$5,
        config=COALESCE($6,config),
        version=version+1,updated_at=now()
      WHERE id=$1 AND owner_id=$2`,
      [id, user, data.name ?? null, shared, org, data.config ?? null],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new HttpError(409, "VIEW_NAME_TAKEN");
    throw e;
  }
  return { ok: true };
}

export async function deleteView(user: string, id: string) {
  const r = await pool.query(
    "DELETE FROM saved_views WHERE id=$1 AND owner_id=$2",
    [id, user],
  );
  if (!r.rowCount) throw new HttpError(404, "NOT_FOUND");
  return { ok: true };
}
