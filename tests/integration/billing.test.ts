import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
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
import { feeMinor, formatBps, percentToBps } from "../../src/lib/entry";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Billing");
});
after(() => pool.end());

async function delivered(carrierId = t.carrier) {
  const load = await bookedLoad(t.dispatcher, carrierId);
  const driver = carrierId === t.carrier ? t.driver : randomUUID();
  if (carrierId !== t.carrier)
    await pool.query(
      "INSERT INTO drivers(id,carrier_id,name) VALUES($1,$2,'Foreign driver')",
      [driver, carrierId],
    );
  let version = (
    await mutate(t.dispatcher, load.id, "assign", {
      version: 1,
      driverId: driver,
    })
  ).version;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    version = (
      await mutate(t.dispatcher, load.id, "milestones", { version, stage })
    ).version;
  return load;
}
async function acceptPaperwork(loadId: string, carrierId = t.carrier) {
  for (const type of ["rate_confirmation", "bol", "pod"]) {
    const v = await uploadDocument(
      t.dispatcher,
      {
        carrier_id: carrierId,
        load_id: loadId,
        type,
        idempotency_key: randomUUID(),
      },
      { name: type + ".pdf", bytes: pdf() },
    );
    await reviewDocument(t.dispatcher, v.version_id, { decision: "accepted" });
  }
}

test("fee math uses integer basis points with half-up rounding", () => {
  assert.equal(percentToBps("8"), 800);
  assert.equal(percentToBps("8.5"), 850);
  assert.equal(percentToBps("12.25"), 1225);
  assert.throws(() => percentToBps("8.125"));
  assert.throws(() => percentToBps("100.01"));
  assert.throws(() => percentToBps("0"), /above 0%/);
  assert.throws(() => percentToBps("0.00"), /above 0%/);
  assert.equal(formatBps(850), "8.5%");
  assert.equal(formatBps(1225), "12.25%");
  assert.equal(feeMinor(250000, 800), "20000");
  assert.equal(feeMinor(1, 5000), "1"); // 0.5 cent rounds up
  assert.equal(feeMinor(1, 4999), "0");
  assert.equal(feeMinor("9007199254740991", 10000), "9007199254740991");
});

test("carrier freight packet requires delivery and accepted paperwork; receipts never exceed it", async () => {
  const load = await delivered();
  const booked = await bookedLoad(t.dispatcher, t.carrier);
  await savePacket(t.manager, booked.id, {
    version: 0,
    bill_to: "Fictional Broker LLC",
    carrier_invoice_number: "BR-1",
    amount_minor: 250000,
  });
  await assert.rejects(submitPacket(t.manager, booked.id, { version: 1 }), {
    code: "LOAD_NOT_DELIVERED",
  });
  await assert.rejects(submitPacket(t.manager, load.id, { version: 1 }), {
    code: "PACKET_REQUIRED",
  });
  let v = (
    await savePacket(t.manager, load.id, {
      version: 0,
      bill_to: "Fictional Broker LLC",
      carrier_invoice_number: "BR-2",
      amount_minor: 250000,
    })
  ).version;
  await assert.rejects(
    savePacket(t.manager, load.id, {
      version: 0,
      bill_to: "x",
      carrier_invoice_number: "x",
      amount_minor: 1,
    }),
    { code: "VERSION_CONFLICT" },
  );
  await assert.rejects(submitPacket(t.manager, load.id, { version: v }), {
    code: "DOCUMENTS_NOT_READY",
  });
  await acceptPaperwork(load.id);
  v = (await submitPacket(t.manager, load.id, { version: v })).version;
  await assert.rejects(
    savePacket(t.manager, load.id, {
      version: v,
      bill_to: "x",
      carrier_invoice_number: "x",
      amount_minor: 1,
    }),
    { code: "PACKET_SUBMITTED" },
  );
  const key = randomUUID();
  const receipt = {
    amount_minor: 200000,
    received_on: "2026-10-20",
    reference: "Broker ACH",
    idempotency_key: key,
  };
  const first = await recordCarrierReceipt(t.manager, load.id, receipt);
  assert.deepEqual(
    await recordCarrierReceipt(t.manager, load.id, receipt),
    first,
  );
  await assert.rejects(
    recordCarrierReceipt(t.manager, load.id, { ...receipt, amount_minor: 1 }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    recordCarrierReceipt(t.manager, load.id, {
      ...receipt,
      amount_minor: 50001,
      idempotency_key: randomUUID(),
    }),
    { code: "PAYMENT_EXCEEDS_BALANCE" },
  );
  await recordCarrierReceipt(t.manager, load.id, {
    ...receipt,
    amount_minor: 50000,
    idempotency_key: randomUUID(),
  });
  const view = await billingOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier }),
  );
  const row = view.loads.find((l) => l.id === load.id)!;
  assert.equal(row.packet.payment_state, "paid");
  assert.equal(row.packet.paid_minor, "250000");
  assert.equal(row.documents_ready, true);
  assert.equal(view.can_invoice, false);
  await assert.rejects(
    pool.query(
      "UPDATE carrier_payment_receipts SET amount_minor=1 WHERE load_id=$1",
      [load.id],
    ),
    /Append-only record/,
  );
});

test("dispatch invoices: dispatcher-only, no double billing, numbered at issue, void releases loads", async () => {
  const a = await delivered();
  const b = await delivered();
  const pending = await bookedLoad(t.dispatcher, t.carrier);
  const input = (load_ids: string[]) => ({
    carrier_id: t.carrier,
    load_ids,
    fee_bps: 850,
    due_on: "2026-11-30",
    idempotency_key: randomUUID(),
  });
  await assert.rejects(createInvoice(t.manager, input([a.id])), {
    code: "DISPATCHER_REQUIRED",
  });
  await assert.rejects(createInvoice(t.dispatcher, input([pending.id])), {
    code: "LOAD_NOT_DELIVERED",
  });
  const foreign = await bookedLoad(t.dispatcher, t.foreign);
  await assert.rejects(createInvoice(t.dispatcher, input([a.id, foreign.id])), {
    code: "NOT_FOUND",
  });
  const draft = await createInvoice(t.dispatcher, input([a.id, b.id]));
  await assert.rejects(createInvoice(t.dispatcher, input([b.id])), {
    code: "LOAD_ALREADY_INVOICED",
  });
  const totals = await pool.query(
    "SELECT total_minor,number FROM dispatch_invoices WHERE id=$1",
    [draft.id],
  );
  assert.equal(totals.rows[0].total_minor, "42500"); // 2 × 8.5% × $2,500.00
  assert.equal(totals.rows[0].number, null);
  const pay = {
    amount_minor: 10000,
    received_on: "2026-10-21",
    method: "ach",
    idempotency_key: randomUUID(),
  };
  await assert.rejects(recordInvoicePayment(t.dispatcher, draft.id, pay), {
    code: "INVOICE_NOT_ISSUED",
  });
  await assert.rejects(
    changeInvoice(t.manager, draft.id, { action: "issue", version: 1 }),
    {
      code: "DISPATCHER_REQUIRED",
    },
  );
  const issued = await changeInvoice(t.dispatcher, draft.id, {
    action: "issue",
    version: 1,
  });
  assert.match(issued.number, /^RLY-\d+$/);
  await recordInvoicePayment(t.dispatcher, draft.id, pay);
  await assert.rejects(
    recordInvoicePayment(t.dispatcher, draft.id, {
      ...pay,
      amount_minor: 32501,
      idempotency_key: randomUUID(),
    }),
    { code: "PAYMENT_EXCEEDS_BALANCE" },
  );
  await assert.rejects(
    changeInvoice(t.dispatcher, draft.id, {
      action: "void",
      version: 2,
      reason: "Wrong fee",
    }),
    { code: "INVOICE_HAS_PAYMENTS" },
  );
  const second = await createInvoice(t.dispatcher, {
    ...input([]),
    load_ids: [(await delivered()).id],
  });
  await changeInvoice(t.dispatcher, second.id, {
    action: "void",
    version: 1,
    reason: "Created in error",
  });
  const view = await billingOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier }),
  );
  const issuedView = view.invoices.find((i) => i.id === draft.id)!;
  assert.equal(issuedView.payment_state, "partial");
  assert.equal(issuedView.paid_minor, "10000");
  assert.equal(issuedView.lines.length, 2);
  const voidedLoad = view.invoices.find((i) => i.id === second.id)!.lines[0]
    .load_id;
  assert.equal(view.loads.find((l) => l.id === voidedLoad)!.invoice, null);
  // The voided invoice released its load, so it can be billed again.
  await createInvoice(t.dispatcher, input([voidedLoad]));
});

test("billing is carrier-isolated and hidden from drivers, including over HTTP", async () => {
  await assert.rejects(
    billingOverview(t.manager, new URLSearchParams({ carrier_id: t.foreign })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    billingOverview(
      t.driverUser,
      new URLSearchParams({ carrier_id: t.carrier }),
    ),
    { code: "NOT_FOUND" },
  );
  const foreign = await bookedLoad(t.dispatcher, t.foreign);
  await assert.rejects(
    savePacket(t.manager, foreign.id, {
      version: 0,
      bill_to: "x",
      carrier_invoice_number: "x",
      amount_minor: 1,
    }),
    { code: "NOT_FOUND" },
  );
  const foreignInvoice = await createInvoice(t.dispatcher, {
    carrier_id: t.foreign,
    load_ids: [(await delivered(t.foreign)).id],
    fee_bps: 1000,
    due_on: "2026-12-01",
    idempotency_key: randomUUID(),
  });
  const token = await sessionFor(t.manager);
  const denied = await POST(
    request("dispatch-invoices/" + foreignInvoice.id + "/payments", {
      token,
      json: {
        amount_minor: 1,
        received_on: "2026-10-21",
        method: "ach",
        idempotency_key: randomUUID(),
      },
    }),
  );
  assert.equal(denied.status, 404);
  const list = await GET(request("billing?carrier_id=" + t.foreign, { token }));
  assert.equal(list.status, 404);
  const floaty = await POST(
    request("loads/" + foreign.id + "/billing-packet", {
      token,
      json: {
        version: 0,
        bill_to: "x",
        carrier_invoice_number: "x",
        amount_minor: 10.5,
      },
    }),
  );
  assert.equal(floaty.status, 400);
});

test("a zero fee, or one that rounds to $0.00, cannot become an invoice", async () => {
  const load = await delivered();
  const input = (fee_bps: number) => ({
    carrier_id: t.carrier,
    load_ids: [load.id],
    fee_bps,
    due_on: "2026-11-30",
    idempotency_key: randomUUID(),
  });
  await assert.rejects(createInvoice(t.dispatcher, input(0)));
  await pool.query("UPDATE loads SET amount_minor=49 WHERE id=$1", [load.id]);
  await assert.rejects(createInvoice(t.dispatcher, input(1)), {
    code: "FEE_TOO_SMALL",
  }); // 49 cents × 0.01% rounds to 0
  const none = await pool.query(
    "SELECT 1 FROM dispatch_invoice_lines WHERE load_id=$1",
    [load.id],
  );
  assert.equal(none.rowCount, 0);
  await pool.query("UPDATE loads SET amount_minor=250000 WHERE id=$1", [
    load.id,
  ]);
  await createInvoice(t.dispatcher, input(1)); // $2,500 × 0.01% = $0.25
});

test("the packet says where to pay the carrier, and records it when it is submitted", async () => {
  const other = await tenant("BillingPayout");
  // Re-use the helpers on this tenant's own carrier.
  const load = await bookedLoad(other.dispatcher, other.carrier);
  let version = (
    await mutate(other.dispatcher, load.id, "assign", {
      version: 1,
      driverId: other.driver,
    })
  ).version;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    version = (
      await mutate(other.dispatcher, load.id, "milestones", { version, stage })
    ).version;
  for (const type of ["rate_confirmation", "bol", "pod"]) {
    const v = await uploadDocument(
      other.dispatcher,
      {
        carrier_id: other.carrier,
        load_id: load.id,
        type,
        idempotency_key: randomUUID(),
      },
      { name: type + ".pdf", bytes: pdf() },
    );
    await reviewDocument(other.dispatcher, v.version_id, {
      decision: "accepted",
    });
  }
  const overview = () =>
    billingOverview(
      other.manager,
      new URLSearchParams({ carrier_id: other.carrier }),
    );
  assert.equal((await overview()).payout, null);
  await pool.query(
    `INSERT INTO carrier_payout_details(carrier_id,payee_name,method,account_last4,effective_at)
     VALUES($1,'Fictional Payee LLC','ach','4321',now()+interval '1 day')`,
    [other.carrier],
  );
  const shown = (await overview()).payout!;
  assert.equal(shown.payee_name, "Fictional Payee LLC");
  assert.equal(shown.account_last4, "4321");
  assert.equal(shown.cooling_off, true);
  await savePacket(other.manager, load.id, {
    version: 0,
    bill_to: "Fictional Broker LLC",
    carrier_invoice_number: "RM-1",
    amount_minor: 250000,
  });
  await submitPacket(other.manager, load.id, { version: 1 });
  const logged = await pool.query(
    "SELECT payload FROM load_events WHERE load_id=$1 AND type='billing.packet_submitted'",
    [load.id],
  );
  assert.deepEqual(logged.rows[0].payload.remit_to, {
    payee_name: "Fictional Payee LLC",
    method: "ach",
    account_last4: "4321",
    in_force: false,
  });
});
