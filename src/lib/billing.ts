import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { event, member, scoped } from "./loads";
import { emit } from "./onboarding";
import { loadDocumentSlots } from "./documents";
import { feeMinor } from "./entry";

const money = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key = z.uuid().transform((v) => v.toLowerCase());
const sum = (values: (string | number)[]) =>
  values.reduce<bigint>((total, v) => total + BigInt(v), 0n);

/** Managing access to a carrier's billing: dispatchers and carrier managers. */
async function billingMember(c: PoolClient, user: string, carrierId: string) {
  return member(c, user, carrierId, true);
}
async function once<T extends Record<string, unknown>>(
  c: PoolClient,
  user: string,
  idempotencyKey: string,
  scope: string,
  table: string,
  actorColumn: string,
  hash: string,
  existing: (row: Record<string, unknown>) => T,
) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    user + ":" + scope + ":" + idempotencyKey,
  ]);
  const old = await c.query(
    `SELECT * FROM ${table} WHERE ${actorColumn}=$1 AND idempotency_key=$2`,
    [user, idempotencyKey],
  );
  if (!old.rows[0]) return null;
  if (old.rows[0].request_hash !== hash)
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return existing(old.rows[0]);
}

// ---------- Carrier freight billing ----------

export const packetSchema = z
  .object({
    version: z.number().int().nonnegative(),
    bill_to: z.string().trim().min(1).max(200),
    carrier_invoice_number: z.string().trim().min(1).max(60),
    amount_minor: money,
  })
  .strict();

export async function savePacket(user: string, loadId: string, input: unknown) {
  const data = packetSchema.parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, loadId, true);
    const current = await c.query(
      "SELECT * FROM carrier_billing_packets WHERE load_id=$1 FOR UPDATE",
      [loadId],
    );
    const packet = current.rows[0];
    if ((packet?.version ?? 0) !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (packet?.status === "submitted")
      throw new HttpError(422, "PACKET_SUBMITTED");
    if (packet)
      await c.query(
        "UPDATE carrier_billing_packets SET bill_to=$2,carrier_invoice_number=$3,amount_minor=$4,version=version+1,updated_at=now() WHERE load_id=$1",
        [loadId, data.bill_to, data.carrier_invoice_number, data.amount_minor],
      );
    else
      await c.query(
        "INSERT INTO carrier_billing_packets(load_id,carrier_id,bill_to,carrier_invoice_number,amount_minor,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          loadId,
          load.carrier_id,
          data.bill_to,
          data.carrier_invoice_number,
          data.amount_minor,
          user,
        ],
      );
    await event(c, user, load, "billing.packet_saved", {
      amount_minor: data.amount_minor,
      carrier_invoice_number: data.carrier_invoice_number,
    });
    return { load_id: loadId, version: data.version + 1 };
  });
}

/** Submission records that the carrier's packet went out; nothing is sent. */
export async function submitPacket(
  user: string,
  loadId: string,
  input: unknown,
) {
  const data = z
    .object({ version: z.number().int().positive() })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, loadId, true);
    const { rows } = await c.query(
      "SELECT * FROM carrier_billing_packets WHERE load_id=$1 FOR UPDATE",
      [loadId],
    );
    const packet = rows[0];
    if (!packet) throw new HttpError(422, "PACKET_REQUIRED");
    if (packet.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (packet.status === "submitted")
      throw new HttpError(422, "PACKET_SUBMITTED");
    if (load.stage !== "delivered")
      throw new HttpError(422, "LOAD_NOT_DELIVERED");
    const slots = await loadDocumentSlots(c, loadId);
    if (slots.some((s) => s.status !== "accepted"))
      throw new HttpError(422, "DOCUMENTS_NOT_READY");
    await c.query(
      "UPDATE carrier_billing_packets SET status='submitted',submitted_at=now(),submitted_by=$2,version=version+1,updated_at=now() WHERE load_id=$1",
      [loadId, user],
    );
    await event(c, user, load, "billing.packet_submitted", {
      amount_minor: packet.amount_minor,
      document_versions: slots.map((s) => s.current?.id),
    });
    return { load_id: loadId, version: packet.version + 1 };
  });
}

export const receiptSchema = z
  .object({
    amount_minor: money,
    received_on: z.iso.date(),
    reference: z.string().trim().max(100).default(""),
    idempotency_key: key,
  })
  .strict();

export async function recordCarrierReceipt(
  user: string,
  loadId: string,
  input: unknown,
) {
  const data = receiptSchema.parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, loadId, true);
    const { idempotency_key, ...fields } = data;
    const hash = digest(JSON.stringify({ loadId, ...fields }));
    const replay = await once(
      c,
      user,
      idempotency_key,
      "receipt",
      "carrier_payment_receipts",
      "recorded_by",
      hash,
      (r) => ({ id: r.id as string }),
    );
    if (replay) return replay;
    const { rows } = await c.query(
      "SELECT * FROM carrier_billing_packets WHERE load_id=$1 FOR UPDATE",
      [loadId],
    );
    if (rows[0]?.status !== "submitted")
      throw new HttpError(422, "PACKET_NOT_SUBMITTED");
    const paid = await c.query(
      "SELECT amount_minor FROM carrier_payment_receipts WHERE load_id=$1",
      [loadId],
    );
    if (
      sum(paid.rows.map((r) => r.amount_minor)) + BigInt(data.amount_minor) >
      BigInt(rows[0].amount_minor)
    )
      throw new HttpError(422, "PAYMENT_EXCEEDS_BALANCE");
    const id = randomUUID();
    await c.query(
      "INSERT INTO carrier_payment_receipts(id,load_id,carrier_id,amount_minor,received_on,reference,recorded_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        loadId,
        load.carrier_id,
        data.amount_minor,
        data.received_on,
        data.reference,
        user,
        idempotency_key,
        hash,
      ],
    );
    await event(c, user, load, "billing.carrier_receipt_recorded", {
      receipt_id: id,
      amount_minor: data.amount_minor,
      received_on: data.received_on,
    });
    return { id };
  });
}

// ---------- Relay dispatch-service invoices ----------

async function requireDispatcher(
  c: PoolClient,
  user: string,
  carrierId: string,
) {
  const m = await billingMember(c, user, carrierId);
  if (m.role !== "dispatcher") throw new HttpError(403, "DISPATCHER_REQUIRED");
}

export const invoiceSchema = z
  .object({
    carrier_id: z.uuid(),
    load_ids: z.array(z.uuid()).min(1).max(100),
    fee_bps: z.number().int().min(0).max(10000),
    due_on: z.iso.date(),
    idempotency_key: key,
  })
  .strict()
  .refine((d) => new Set(d.load_ids).size === d.load_ids.length, {
    message: "Each load can appear once",
  });

export async function createInvoice(user: string, input: unknown) {
  const data = invoiceSchema.parse(input);
  return transaction(async (c) => {
    await requireDispatcher(c, user, data.carrier_id);
    const { idempotency_key, ...fields } = data;
    const hash = digest(
      JSON.stringify({ ...fields, load_ids: [...fields.load_ids].sort() }),
    );
    const replay = await once(
      c,
      user,
      idempotency_key,
      "dispatch-invoice",
      "dispatch_invoices",
      "created_by",
      hash,
      (r) => ({ id: r.id as string, version: r.version as number }),
    );
    if (replay) return replay;
    const loads = await c.query(
      "SELECT id,amount_minor,stage FROM loads WHERE carrier_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
      [data.carrier_id, data.load_ids],
    );
    if (loads.rowCount !== data.load_ids.length)
      throw new HttpError(404, "NOT_FOUND");
    if (loads.rows.some((l) => l.stage !== "delivered"))
      throw new HttpError(422, "LOAD_NOT_DELIVERED");
    const billed = await c.query(
      "SELECT 1 FROM dispatch_invoice_lines WHERE load_id=ANY($1::uuid[]) AND active LIMIT 1",
      [data.load_ids],
    );
    if (billed.rowCount) throw new HttpError(422, "LOAD_ALREADY_INVOICED");
    const lines = loads.rows.map((l) => ({
      load_id: l.id as string,
      load_amount_minor: String(l.amount_minor),
      fee_minor: feeMinor(l.amount_minor, data.fee_bps),
    }));
    const total = sum(lines.map((l) => l.fee_minor));
    const id = randomUUID();
    await c.query(
      "INSERT INTO dispatch_invoices(id,carrier_id,fee_bps,total_minor,due_on,created_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        data.carrier_id,
        data.fee_bps,
        total.toString(),
        data.due_on,
        user,
        idempotency_key,
        hash,
      ],
    );
    for (const line of lines)
      await c.query(
        "INSERT INTO dispatch_invoice_lines(id,invoice_id,carrier_id,load_id,load_amount_minor,fee_minor) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          id,
          data.carrier_id,
          line.load_id,
          line.load_amount_minor,
          line.fee_minor,
        ],
      );
    await emit(c, user, data.carrier_id, "dispatch_invoice.created", {
      invoice_id: id,
      total_minor: total.toString(),
      fee_bps: data.fee_bps,
      load_ids: data.load_ids,
    });
    return { id, version: 1 };
  });
}

export const invoiceActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("issue"),
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("void"),
      version: z.number().int().positive(),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

async function lockInvoice(c: PoolClient, user: string, id: string) {
  const { rows } = await c.query(
    `SELECT i.* FROM dispatch_invoices i JOIN memberships m ON m.carrier_id=i.carrier_id AND m.user_id=$2
    WHERE i.id=$1 AND m.role IN ('dispatcher','carrier-manager') FOR UPDATE OF i`,
    [id, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  await requireDispatcher(c, user, rows[0].carrier_id);
  return rows[0];
}

export async function changeInvoice(user: string, id: string, input: unknown) {
  const data = invoiceActionSchema.parse(input);
  return transaction(async (c) => {
    const invoice = await lockInvoice(c, user, id);
    if (invoice.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (invoice.status === "void") throw new HttpError(422, "INVOICE_VOID");
    let number = invoice.number;
    if (data.action === "issue") {
      if (invoice.status !== "draft")
        throw new HttpError(422, "INVALID_TRANSITION");
      const seq = await c.query("SELECT nextval('dispatch_invoice_number') n");
      number = "RLY-" + seq.rows[0].n;
      await c.query(
        "UPDATE dispatch_invoices SET status='issued',number=$2,issued_at=now(),issued_by=$3 WHERE id=$1",
        [id, number, user],
      );
    } else {
      const paid = await c.query(
        "SELECT 1 FROM dispatch_invoice_payments WHERE invoice_id=$1 LIMIT 1",
        [id],
      );
      if (paid.rowCount) throw new HttpError(422, "INVOICE_HAS_PAYMENTS");
      await c.query(
        "UPDATE dispatch_invoices SET status='void',voided_at=now(),voided_by=$2,void_reason=$3 WHERE id=$1",
        [id, user, data.reason],
      );
      await c.query(
        "UPDATE dispatch_invoice_lines SET active=false WHERE invoice_id=$1",
        [id],
      );
    }
    await c.query(
      "UPDATE dispatch_invoices SET version=version+1 WHERE id=$1",
      [id],
    );
    await emit(c, user, invoice.carrier_id, "dispatch_invoice." + data.action, {
      invoice_id: id,
      number,
    });
    return { id, version: invoice.version + 1, number };
  });
}

export const invoicePaymentSchema = z
  .object({
    amount_minor: money,
    received_on: z.iso.date(),
    method: z.enum(["ach", "check", "wire", "card", "other"]),
    reference: z.string().trim().max(100).default(""),
    idempotency_key: key,
  })
  .strict();

export async function recordInvoicePayment(
  user: string,
  id: string,
  input: unknown,
) {
  const data = invoicePaymentSchema.parse(input);
  return transaction(async (c) => {
    const invoice = await lockInvoice(c, user, id);
    const { idempotency_key, ...fields } = data;
    const hash = digest(JSON.stringify({ id, ...fields }));
    const replay = await once(
      c,
      user,
      idempotency_key,
      "invoice-payment",
      "dispatch_invoice_payments",
      "recorded_by",
      hash,
      (r) => ({ id: r.id as string }),
    );
    if (replay) return replay;
    if (invoice.status !== "issued")
      throw new HttpError(422, "INVOICE_NOT_ISSUED");
    const paid = await c.query(
      "SELECT amount_minor FROM dispatch_invoice_payments WHERE invoice_id=$1",
      [id],
    );
    if (
      sum(paid.rows.map((r) => r.amount_minor)) + BigInt(data.amount_minor) >
      BigInt(invoice.total_minor)
    )
      throw new HttpError(422, "PAYMENT_EXCEEDS_BALANCE");
    const paymentId = randomUUID();
    await c.query(
      "INSERT INTO dispatch_invoice_payments(id,invoice_id,carrier_id,amount_minor,received_on,method,reference,recorded_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        paymentId,
        id,
        invoice.carrier_id,
        data.amount_minor,
        data.received_on,
        data.method,
        data.reference,
        user,
        idempotency_key,
        hash,
      ],
    );
    await emit(
      c,
      user,
      invoice.carrier_id,
      "dispatch_invoice.payment_recorded",
      {
        invoice_id: id,
        payment_id: paymentId,
        amount_minor: data.amount_minor,
      },
    );
    return { id: paymentId };
  });
}

export function paymentState(totalMinor: string, paidMinor: string) {
  const total = BigInt(totalMinor),
    paid = BigInt(paidMinor);
  return paid >= total ? "paid" : paid === 0n ? "unpaid" : "partial";
}

export async function billingOverview(user: string, params: URLSearchParams) {
  const carrierId = z.uuid().parse(params.get("carrier_id"));
  return transaction(async (c) => {
    const membership = await billingMember(c, user, carrierId);
    const loads = await c.query(
      `SELECT l.id,l.reference,l.stage,l.amount_minor::text,l.created_at,
        CASE WHEN p.load_id IS NULL THEN NULL ELSE json_build_object(
          'bill_to',p.bill_to,'carrier_invoice_number',p.carrier_invoice_number,
          'amount_minor',p.amount_minor::text,'status',p.status,'submitted_at',p.submitted_at,
          'version',p.version,
          'paid_minor',(SELECT COALESCE(sum(r.amount_minor),0)::text FROM carrier_payment_receipts r WHERE r.load_id=l.id),
          'receipts',(SELECT COALESCE(json_agg(json_build_object('id',r.id,'amount_minor',r.amount_minor::text,'received_on',r.received_on,'reference',r.reference) ORDER BY r.received_on),'[]') FROM carrier_payment_receipts r WHERE r.load_id=l.id)
        ) END packet,
        (SELECT json_build_object('invoice_id',i.id,'number',i.number,'status',i.status)
          FROM dispatch_invoice_lines dl JOIN dispatch_invoices i ON i.id=dl.invoice_id
          WHERE dl.load_id=l.id AND dl.active) invoice
      FROM loads l LEFT JOIN carrier_billing_packets p ON p.load_id=l.id
      WHERE l.carrier_id=$1 ORDER BY l.created_at DESC,l.id LIMIT 100`,
      [carrierId],
    );
    const ready: Record<string, boolean> = {};
    for (const l of loads.rows)
      ready[l.id] = (await loadDocumentSlots(c, l.id)).every(
        (s) => s.status === "accepted",
      );
    const invoices = await c.query(
      `SELECT i.id,i.number,i.status,i.fee_bps,i.total_minor::text,to_char(i.due_on,'YYYY-MM-DD') due_on,
        i.issued_at,i.voided_at,i.void_reason,i.created_at,i.version,
        (SELECT COALESCE(sum(amount_minor),0)::text FROM dispatch_invoice_payments WHERE invoice_id=i.id) paid_minor,
        (SELECT json_agg(json_build_object('load_id',dl.load_id,'reference',l.reference,'load_amount_minor',dl.load_amount_minor::text,'fee_minor',dl.fee_minor::text) ORDER BY l.reference)
          FROM dispatch_invoice_lines dl JOIN loads l ON l.id=dl.load_id WHERE dl.invoice_id=i.id) lines,
        (SELECT COALESCE(json_agg(json_build_object('id',p.id,'amount_minor',p.amount_minor::text,'received_on',p.received_on,'method',p.method,'reference',p.reference) ORDER BY p.received_on),'[]')
          FROM dispatch_invoice_payments p WHERE p.invoice_id=i.id) payments
      FROM dispatch_invoices i WHERE i.carrier_id=$1 ORDER BY i.created_at DESC,i.id LIMIT 100`,
      [carrierId],
    );
    return {
      carrier_id: carrierId,
      can_invoice: membership.role === "dispatcher",
      loads: loads.rows.map((l) => ({
        ...l,
        documents_ready: ready[l.id],
        packet: l.packet && {
          ...l.packet,
          payment_state: paymentState(
            l.packet.amount_minor,
            l.packet.paid_minor,
          ),
        },
      })),
      invoices: invoices.rows.map((i) => ({
        ...i,
        payment_state:
          i.status === "issued"
            ? paymentState(i.total_minor, i.paid_minor)
            : null,
      })),
    };
  });
}
