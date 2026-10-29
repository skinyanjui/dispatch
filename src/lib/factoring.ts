import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { member } from "./loads";
import { emit } from "./onboarding";
import { csvCell } from "./csv";
import { loadDocumentSlotsFor } from "./documents";
import { payoutDetails } from "./change-control";
import { sameName } from "./authority-state";

/**
 * Factoring handoff (ADR 0069). The carrier consents, once, to share its billing
 * data with a named factor. Relay then prepares a schedule of invoices (a CSV)
 * from loads that are delivered, fully documented and billed but not yet paid,
 * and records that the carrier handed it over. Relay never sends anything to a
 * factor. Payout instructions must be in force (not cooling off, ADR 0064).
 */
const key = z.uuid();
const settingsSchema = z
  .object({
    carrier_id: z.uuid(),
    enabled: z.boolean(),
    factor_name: z.string().trim().max(160),
    // Enabling needs the carrier to say so explicitly.
    consent: z.boolean().default(false),
  })
  .strict()
  .refine((d) => !d.enabled || d.factor_name !== "", {
    message: "Name the factor",
    path: ["factor_name"],
  })
  .refine((d) => !d.enabled || d.consent, {
    message: "Consent to share billing data with the factor is required",
    path: ["consent"],
  });
const batchSchema = z
  .object({
    carrier_id: z.uuid(),
    load_ids: z.array(z.uuid()).min(1).max(100),
    key,
  })
  .strict()
  .refine((d) => new Set(d.load_ids).size === d.load_ids.length, {
    message: "Each load can appear once",
  });
const versionOnly = z.object({ version: z.number().int().positive() }).strict();
const voidSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    // Needed when the schedule was already handed to the factor.
    factor_informed: z.boolean().default(false),
  })
  .strict();
const releaseSchema = z
  .object({
    version: z.number().int().positive(),
    // The factor has confirmed it has not advanced against these invoices.
    factor_confirmed_no_advance: z.literal(true),
  })
  .strict();

const iso = (v: unknown) => new Date(v as string).toISOString();
const dollars = (minor: string) => {
  const n = BigInt(minor);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
};

export type Ineligible =
  | "not_delivered"
  | "no_packet"
  | "packet_not_submitted"
  | "paperwork_incomplete"
  | "already_paid"
  | "already_in_batch"
  | "held_after_handoff";
export const ineligibleLabels: Record<Ineligible, string> = {
  not_delivered: "Not delivered",
  no_packet: "No billing packet",
  packet_not_submitted: "Billing packet not submitted",
  paperwork_incomplete: "Paperwork not all accepted",
  already_paid: "Already paid",
  already_in_batch: "Already in a batch",
  held_after_handoff:
    "Held until the factor confirms it has not advanced on it",
};

/**
 * Loads with the reason each cannot go in a schedule (or null). `readyOnly`
 * looks only at loads that could (delivered, billed, unpaid, in no batch), so a
 * long history cannot hide an old load that is ready (ADR 0071).
 */
async function candidates(
  c: PoolClient,
  carrierId: string,
  opts: { only?: string[]; readyOnly?: boolean; limit?: number } = {},
) {
  const { only, readyOnly = false, limit = 300 } = opts;
  const rows = await c.query(
    `SELECT l.id,l.reference,l.stage,p.status packet_status,p.bill_to,p.carrier_invoice_number,p.amount_minor::text amount,
       to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD') submitted_on,
       (SELECT to_char(min(e.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM load_events e
          WHERE e.load_id=l.id AND e.type='load.milestones' AND e.payload->>'stage'='delivered') delivered_on,
       (SELECT COALESCE(sum(r.amount_minor),0)::text FROM carrier_payment_receipts r WHERE r.load_id=l.id) paid,
       EXISTS(SELECT 1 FROM factoring_batch_loads f WHERE f.load_id=l.id AND f.active) in_batch,
       EXISTS(SELECT 1 FROM factoring_batch_loads f JOIN factoring_batches b ON b.id=f.batch_id
         WHERE f.load_id=l.id AND f.active AND b.status='void') held
     FROM loads l LEFT JOIN carrier_billing_packets p ON p.load_id=l.id
     WHERE l.carrier_id=$1 AND l.cancelled_at IS NULL AND ($2::uuid[] IS NULL OR l.id=ANY($2::uuid[]))
       AND ($3::boolean=false OR (l.stage='delivered' AND p.status='submitted'
         AND COALESCE((SELECT sum(r.amount_minor) FROM carrier_payment_receipts r WHERE r.load_id=l.id),0)<p.amount_minor
         AND NOT EXISTS(SELECT 1 FROM factoring_batch_loads f WHERE f.load_id=l.id AND f.active)))
     ORDER BY l.created_at DESC,l.id LIMIT $4`,
    [carrierId, only ?? null, readyOnly, limit],
  );
  const slots = await loadDocumentSlotsFor(
    c,
    rows.rows.map((r) => r.id as string),
  );
  return rows.rows.map((r) => {
    let reason = null as Ineligible | null;
    if (r.stage !== "delivered") reason = "not_delivered";
    else if (!r.packet_status) reason = "no_packet";
    else if (r.packet_status !== "submitted") reason = "packet_not_submitted";
    else if (!slots.get(r.id)!.every((s) => s.status === "accepted"))
      reason = "paperwork_incomplete";
    else if (BigInt(r.paid) >= BigInt(r.amount)) reason = "already_paid";
    else if (r.held) reason = "held_after_handoff";
    else if (r.in_batch) reason = "already_in_batch";
    return { ...r, reason: reason as Ineligible | null };
  });
}

async function settings(c: PoolClient, carrierId: string) {
  const r = await c.query(
    `SELECT f.enabled,f.factor_name,f.consented_at,u.name consented_by
     FROM carrier_factoring f LEFT JOIN users u ON u.id=f.consented_by WHERE f.carrier_id=$1`,
    [carrierId],
  );
  const row = r.rows[0];
  return {
    enabled: (row?.enabled as boolean) ?? false,
    factor_name: (row?.factor_name as string) ?? "",
    consented_by: (row?.consented_by as string | null) ?? null,
    consented_at: row?.consented_at ? iso(row.consented_at) : null,
  };
}

const batchView = (r: Record<string, unknown>) => ({
  id: r.id as string,
  factor_name: r.factor_name as string,
  status: r.status as "prepared" | "handed_off" | "void",
  load_count: r.load_count as number,
  total_minor: r.total_minor as string,
  file_sha256: r.file_sha256 as string,
  created_at: iso(r.created_at),
  handed_off_at: r.handed_off_at ? iso(r.handed_off_at) : null,
  void_reason: (r.void_reason as string | null) ?? null,
  // Cancelled after it was handed over, and its loads are still held.
  loads_held: r.status === "void" && !!r.handed_off_at && !r.loads_released_at,
  version: r.version as number,
});
const batchSql = `SELECT id,factor_name,status,load_count,total_minor::text,file_sha256,created_at,handed_off_at,void_reason,loads_released_at,version FROM factoring_batches`;

/** Settings, loads that can go in a batch (or why not) and past batches. */
export async function factoringOverview(
  user: string,
  carrierParam: string | null,
  limits: { readyLimit?: number; recentLimit?: number } = {},
) {
  const carrierId = z.uuid().parse(carrierParam);
  return transaction(async (c) => {
    const m = await member(c, user, carrierId, true);
    const s = await settings(c, carrierId);
    const payout = await payoutDetails(c, carrierId);
    // Every load that is ready is listed, however old; of the rest only the
    // newest are, each with the reason it is not ready.
    const readyLimit = limits.readyLimit ?? 1000;
    const ready = s.enabled
      ? await candidates(c, carrierId, {
          readyOnly: true,
          limit: readyLimit + 1,
        })
      : [];
    const recent = s.enabled
      ? await candidates(c, carrierId, { limit: limits.recentLimit ?? 100 })
      : [];
    const readyTruncated = ready.length > readyLimit;
    const seen = new Set(ready.slice(0, readyLimit).map((l) => l.id as string));
    const loads = [
      ...ready.slice(0, readyLimit),
      ...recent.filter((l) => !seen.has(l.id as string)),
    ].sort((a, b) => Number(!!a.reason) - Number(!!b.reason));
    const batches = await c.query(
      `${batchSql} WHERE carrier_id=$1 ORDER BY created_at DESC,id LIMIT 50`,
      [carrierId],
    );
    return {
      carrier_id: carrierId,
      can_consent: m.role === "carrier-manager",
      settings: s,
      ready_truncated: readyTruncated,
      payout_in_force: !!payout && !payout.cooling_off,
      payout_names_factor: !!payout && payoutNamesFactor(payout, s.factor_name),
      payout_payee: payout?.payee_name ?? null,
      payout_cooling_off: !!payout?.cooling_off,
      loads: loads.map((l) => ({
        id: l.id as string,
        reference: l.reference as string,
        bill_to: (l.bill_to as string | null) ?? null,
        invoice_number: (l.carrier_invoice_number as string | null) ?? null,
        amount_minor: (l.amount as string | null) ?? null,
        eligible: l.reason === null,
        reason: l.reason,
        reason_label: l.reason
          ? ineligibleLabels[l.reason as Ineligible]
          : null,
      })),
      batches: batches.rows.map(batchView),
    };
  });
}

/** Only the carrier's own manager can agree to share its billing data. */
export async function saveFactoringSettings(user: string, input: unknown) {
  const data = settingsSchema.parse(input);
  return transaction(async (c) => {
    const m = await member(c, user, data.carrier_id, true);
    if (m.role !== "carrier-manager") throw new HttpError(404, "NOT_FOUND");
    const before = await settings(c, data.carrier_id);
    const keepConsent =
      before.enabled && before.factor_name === data.factor_name;
    await c.query(
      `INSERT INTO carrier_factoring(carrier_id,enabled,factor_name,consented_by,consented_at)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(carrier_id) DO UPDATE SET enabled=$2,factor_name=$3,
         consented_by=CASE WHEN $2 THEN (CASE WHEN $6 THEN carrier_factoring.consented_by ELSE $4 END) ELSE carrier_factoring.consented_by END,
         consented_at=CASE WHEN $2 THEN (CASE WHEN $6 THEN carrier_factoring.consented_at ELSE $5 END) ELSE carrier_factoring.consented_at END,
         updated_at=now()`,
      [
        data.carrier_id,
        data.enabled,
        data.factor_name,
        data.enabled ? user : null,
        data.enabled ? new Date() : null,
        keepConsent,
      ],
    );
    await emit(
      c,
      user,
      data.carrier_id,
      data.enabled ? "factoring.enabled" : "factoring.disabled",
      {
        factor: data.factor_name,
      },
    );
    return settings(c, data.carrier_id);
  });
}

/** Payout details point at the factor: paid by "factor" to a payee matching its name (ADR 0071). */
export function payoutNamesFactor(
  payout: { method: string; payee_name: string },
  factorName: string,
) {
  return payout.method === "factor" && sameName(payout.payee_name, factorName);
}

const header = [
  "carrier_invoice_number",
  "load_reference",
  "bill_to",
  "amount",
  "currency",
  "delivered_on",
  "invoice_submitted_on",
  "documents",
];

export async function createBatch(user: string, input: unknown) {
  const data = batchSchema.parse(input);
  const hash = digest(JSON.stringify(data));
  return transaction(async (c) => {
    await member(c, user, data.carrier_id, true);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":factoring:" + data.key,
    ]);
    const old = await c.query(
      "SELECT id,request_hash,version FROM factoring_batches WHERE created_by=$1 AND idempotency_key=$2",
      [user, data.key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return {
        id: old.rows[0].id as string,
        version: old.rows[0].version as number,
      };
    }
    const s = await settings(c, data.carrier_id);
    if (!s.enabled) throw new HttpError(409, "FACTORING_NOT_ENABLED");
    const payout = await payoutDetails(c, data.carrier_id);
    if (!payout) throw new HttpError(422, "PAYOUT_DETAILS_REQUIRED");
    if (payout.cooling_off)
      throw new HttpError(422, "PAYOUT_DETAILS_COOLING_OFF");
    // The factor pays whoever the payout details name, so they must name the factor.
    if (!payoutNamesFactor(payout, s.factor_name))
      throw new HttpError(422, "PAYOUT_NOT_TO_FACTOR");
    const found = await candidates(c, data.carrier_id, {
      only: data.load_ids,
      limit: data.load_ids.length,
    });
    // A guessed or foreign id is simply absent from the carrier's own list.
    if (found.length !== data.load_ids.length)
      throw new HttpError(404, "NOT_FOUND");
    const bad = found.find((l) => l.reason);
    if (bad) throw new HttpError(422, "LOAD_NOT_ELIGIBLE");
    const rows = data.load_ids.map((id) => found.find((l) => l.id === id)!);
    const total = rows.reduce((t, l) => t + BigInt(l.amount), 0n);
    const csv =
      [
        header,
        ...rows.map((l) => [
          l.carrier_invoice_number,
          l.reference,
          l.bill_to,
          dollars(l.amount),
          "USD",
          l.delivered_on,
          l.submitted_on,
          "rate confirmation, bill of lading and proof of delivery accepted",
        ]),
      ]
        .map((r) => r.map(csvCell).join(","))
        .join("\r\n") + "\r\n";
    const id = randomUUID();
    const change = await c.query(
      "SELECT change_id FROM carrier_payout_details WHERE carrier_id=$1",
      [data.carrier_id],
    );
    await c.query(
      `INSERT INTO factoring_batches(id,carrier_id,factor_name,load_count,total_minor,file_sha256,file_csv,payout_change_id,created_by,idempotency_key,request_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        data.carrier_id,
        s.factor_name,
        rows.length,
        total.toString(),
        createHash("sha256").update(csv).digest("hex"),
        csv,
        change.rows[0]?.change_id ?? null,
        user,
        data.key,
        hash,
      ],
    );
    for (const l of rows)
      await c.query(
        "INSERT INTO factoring_batch_loads(batch_id,carrier_id,load_id,amount_minor) VALUES($1,$2,$3,$4)",
        [id, data.carrier_id, l.id, l.amount],
      );
    await emit(c, user, data.carrier_id, "factoring.batch_prepared", {
      batch_id: id,
      loads: rows.length,
    });
    return { id, version: 1 };
  });
}

async function lockBatch(c: PoolClient, user: string, id: string) {
  const r = await c.query(
    "SELECT * FROM factoring_batches WHERE id=$1 FOR UPDATE",
    [id],
  );
  if (!r.rows[0]) throw new HttpError(404, "NOT_FOUND");
  await member(c, user, r.rows[0].carrier_id, true);
  return r.rows[0];
}

/** The carrier says it gave the schedule to its factor. Relay sends nothing. */
export async function markHandedOff(user: string, id: string, input: unknown) {
  const data = versionOnly.parse(input);
  return transaction(async (c) => {
    const b = await lockBatch(c, user, id);
    if (b.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (b.status !== "prepared") throw new HttpError(409, "BATCH_NOT_PREPARED");
    await c.query(
      "UPDATE factoring_batches SET status='handed_off',handed_off_at=now(),handed_off_by=$2,version=version+1 WHERE id=$1",
      [id, user],
    );
    await emit(c, user, b.carrier_id, "factoring.batch_handed_off", {
      batch_id: id,
    });
    return { id, version: b.version + 1 };
  });
}

/**
 * Cancels a batch. A schedule that was only prepared frees its loads at once.
 * One already handed to the factor may have been advanced against, so cancelling
 * it needs the carrier to say the factor was told, and its loads stay held until
 * `releaseBatchLoads`: otherwise the same invoices could be financed twice.
 */
export async function voidBatch(user: string, id: string, input: unknown) {
  const data = voidSchema.parse(input);
  return transaction(async (c) => {
    const b = await lockBatch(c, user, id);
    if (b.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (b.status === "void") throw new HttpError(409, "BATCH_VOID");
    const handedOff = b.status === "handed_off";
    if (handedOff && !data.factor_informed)
      throw new HttpError(422, "FACTOR_NOTICE_REQUIRED");
    await c.query(
      "UPDATE factoring_batches SET status='void',voided_at=now(),voided_by=$2,void_reason=$3,version=version+1 WHERE id=$1",
      [id, user, data.reason],
    );
    if (!handedOff)
      await c.query(
        "UPDATE factoring_batch_loads SET active=false WHERE batch_id=$1",
        [id],
      );
    await emit(c, user, b.carrier_id, "factoring.batch_voided", {
      batch_id: id,
      after_handoff: handedOff,
    });
    return { id, version: b.version + 1, loads_held: handedOff };
  });
}

/** Frees the loads of a schedule cancelled after handoff, once the factor confirms. */
export async function releaseBatchLoads(
  user: string,
  id: string,
  input: unknown,
) {
  const data = releaseSchema.parse(input);
  return transaction(async (c) => {
    const b = await lockBatch(c, user, id);
    if (b.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (b.status !== "void" || !b.handed_off_at || b.loads_released_at)
      throw new HttpError(409, "BATCH_NOT_HELD");
    await c.query(
      "UPDATE factoring_batch_loads SET active=false WHERE batch_id=$1",
      [id],
    );
    await c.query(
      "UPDATE factoring_batches SET loads_released_at=now(),loads_released_by=$2,version=version+1 WHERE id=$1",
      [id, user],
    );
    await emit(c, user, b.carrier_id, "factoring.batch_released", {
      batch_id: id,
    });
    return { id, version: b.version + 1 };
  });
}

/** The exact file that was prepared, byte for byte (its hash is recorded). */
export async function batchFile(user: string, id: string) {
  return transaction(async (c) => {
    const b = await lockBatch(c, user, id);
    if (b.file_csv === null) throw new HttpError(410, "FILE_PURGED");
    await emit(c, user, b.carrier_id, "factoring.batch_downloaded", {
      batch_id: id,
    });
    return {
      filename: `factoring-schedule-${String(b.created_at.toISOString()).slice(0, 10)}-${id.slice(0, 8)}.csv`,
      csv: b.file_csv as string,
      sha256: b.file_sha256 as string,
    };
  });
}
