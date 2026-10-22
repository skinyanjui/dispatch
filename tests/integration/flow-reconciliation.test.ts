import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import {
  billingOverview,
  changeInvoice,
  createInvoice,
  recordCarrierReceipt,
  recordInvoicePayment,
  savePacket,
  submitPacket,
} from "../../src/lib/billing";
import { mutate } from "../../src/lib/loads";
import { reviewDocument, uploadDocument } from "../../src/lib/documents";
import { reportOverview } from "../../src/lib/reports";
import { feeMinor } from "../../src/lib/entry";
import { bookedLoad, pdf, tenant } from "./fixtures";

// One carrier walked through the whole money flow, then every figure the
// product shows is compared with an independent sum taken straight from SQL.
let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Flow");
});
after(() => pool.end());

async function deliveredLoad(amountMinor: number) {
  const load = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  await pool.query("UPDATE loads SET amount_minor=$2 WHERE id=$1", [
    load.id,
    amountMinor,
  ]);
  let version = (
    await mutate(t.dispatcher, load.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    version = (
      await mutate(t.dispatcher, load.id, "milestones", { version, stage })
    ).version;
  return load;
}
async function acceptPaperwork(loadId: string) {
  for (const type of ["rate_confirmation", "bol", "pod"]) {
    const v = await uploadDocument(
      t.dispatcher,
      {
        carrier_id: t.carrier,
        load_id: loadId,
        type,
        idempotency_key: randomUUID(),
      },
      { name: type + ".pdf", bytes: pdf() },
    );
    await reviewDocument(t.dispatcher, v.version_id, { decision: "accepted" });
  }
}
const sql = async (text: string, ...args: unknown[]) =>
  (await pool.query(text, args)).rows[0];

test("billing, invoices and reports agree with the raw records after a full flow", async () => {
  const a = await deliveredLoad(250000); // $2,500.00
  const b = await deliveredLoad(123457); // $1,234.57, fee rounds half-up
  const c = await deliveredLoad(99999); // delivered, never billed
  await acceptPaperwork(a.id);

  // Carrier freight billing on load A: submit, then a partial receipt.
  const packet = await savePacket(t.manager, a.id, {
    version: 0,
    bill_to: "Fictional Broker LLC",
    carrier_invoice_number: "FLOW-1",
    amount_minor: 250000,
  });
  await submitPacket(t.manager, a.id, { version: packet.version });
  await recordCarrierReceipt(t.manager, a.id, {
    amount_minor: 100000,
    received_on: "2026-10-20",
    reference: "ACH",
    idempotency_key: randomUUID(),
  });

  // Dispatch fee invoice over A and B, issued, partly paid, already past due.
  const draft = await createInvoice(t.dispatcher, {
    carrier_id: t.carrier,
    load_ids: [a.id, b.id],
    fee_bps: 850,
    due_on: "2020-01-01",
    idempotency_key: randomUUID(),
  });
  await changeInvoice(t.dispatcher, draft.id, { action: "issue", version: 1 });
  await recordInvoicePayment(t.dispatcher, draft.id, {
    amount_minor: 10000,
    received_on: "2026-10-21",
    method: "ach",
    idempotency_key: randomUUID(),
  });

  const feeA = BigInt(feeMinor(250000, 850)); // 21250
  const feeB = BigInt(feeMinor(123457, 850)); // 10494.345 -> 10494
  assert.equal(feeA, 21250n);
  assert.equal(feeB, 10494n);
  const total = feeA + feeB;

  // The stored invoice is exactly the sum of its rounded lines.
  const stored = await sql(
    `SELECT i.total_minor::text,(SELECT sum(fee_minor) FROM dispatch_invoice_lines WHERE invoice_id=i.id)::text lines,
      (SELECT sum(amount_minor) FROM dispatch_invoice_payments WHERE invoice_id=i.id)::text paid
     FROM dispatch_invoices i WHERE i.id=$1`,
    draft.id,
  );
  assert.equal(stored.total_minor, total.toString());
  assert.equal(stored.lines, stored.total_minor);

  // Billing overview.
  const view = await billingOverview(
    t.dispatcher,
    new URLSearchParams({ carrier_id: t.carrier }),
  );
  const inv = view.invoices.find((i) => i.id === draft.id)!;
  assert.equal(inv.total_minor, total.toString());
  assert.equal(inv.paid_minor, "10000");
  assert.equal(inv.payment_state, "partial");
  assert.equal(
    inv.lines.reduce(
      (n: bigint, l: { fee_minor: string }) => n + BigInt(l.fee_minor),
      0n,
    ),
    total,
  );
  const rowA = view.loads.find((l) => l.id === a.id)!;
  assert.equal(rowA.packet.payment_state, "partial");
  assert.equal(rowA.invoice!.invoice_id, draft.id);
  assert.equal(view.loads.find((l) => l.id === c.id)!.invoice, null);

  // Reports for the same carrier.
  const r = await reportOverview(
    t.dispatcher,
    new URLSearchParams(`carrier_id=${t.carrier}`),
  );
  assert.equal(r.loads.loads, 3);
  assert.equal(r.loads.delivered, 3);
  assert.equal(r.loads.freight_minor, String(250000 + 123457 + 99999));
  assert.equal(r.carriers[0].freight_minor, r.loads.freight_minor);
  assert.equal(r.delivered_without_pod, 2); // B and C have no accepted POD
  assert.deepEqual(
    {
      issued: r.dispatch_invoices!.issued,
      issued_minor: r.dispatch_invoices!.issued_minor,
      paid_minor: r.dispatch_invoices!.paid_minor,
      outstanding_minor: r.dispatch_invoices!.outstanding_minor,
      overdue: r.dispatch_invoices!.overdue,
    },
    {
      issued: 1,
      issued_minor: total.toString(),
      paid_minor: "10000",
      outstanding_minor: (total - 10000n).toString(),
      overdue: 1,
    },
  );
  assert.deepEqual(r.carrier_freight_billing, {
    submitted: 1,
    billed_minor: "250000",
    received_minor: "100000",
    outstanding_minor: "150000",
  });
  assert.equal(
    r.weekly.reduce((n: number, w: { loads: number }) => n + w.loads, 0),
    3,
  );

  // A carrier manager sees the same loads but never the dispatcher's own fees.
  const asManager = await reportOverview(
    t.manager,
    new URLSearchParams(`carrier_id=${t.carrier}`),
  );
  assert.equal(asManager.loads.freight_minor, r.loads.freight_minor);
  assert.equal(asManager.dispatch_invoices, null);
});
