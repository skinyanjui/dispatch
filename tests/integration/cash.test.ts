import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import {
  changeInvoice,
  createInvoice,
  recordCarrierReceipt,
  savePacket,
  submitPacket,
} from "../../src/lib/billing";
import { cashOverview } from "../../src/lib/billing-cash";
import {
  averageDays,
  cashStage,
  daysBetween,
  feeOf,
  netOf,
  paidOn,
} from "../../src/lib/cash";
import { mutate } from "../../src/lib/loads";
import { reviewDocument, uploadDocument } from "../../src/lib/documents";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Cash");
});
after(() => pool.end());

const plusDays = (n: number) =>
  new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function delivered() {
  const load = await bookedLoad(t.dispatcher, t.carrier);
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
async function accept(
  loadId: string,
  types = ["rate_confirmation", "bol", "pod"],
) {
  for (const type of types) {
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
async function submitted(loadId: string, ref: string) {
  const v = (
    await savePacket(t.manager, loadId, {
      version: 0,
      bill_to: "Fictional Broker LLC",
      carrier_invoice_number: ref,
      amount_minor: 250000,
    })
  ).version;
  await submitPacket(t.manager, loadId, { version: v });
}
const receipt = (loadId: string, amount: number, on: string) =>
  recordCarrierReceipt(t.manager, loadId, {
    amount_minor: amount,
    received_on: on,
    reference: "ACH",
    idempotency_key: randomUUID(),
  });

test("money and day rules use integers and whole UTC days", () => {
  assert.equal(feeOf("250000", 800), "20000");
  assert.equal(feeOf("1", 5000), "1");
  assert.equal(feeOf("9007199254740991", 10000), "9007199254740991");
  assert.equal(netOf("250000", "20000"), "230000");
  assert.equal(daysBetween("2026-10-01", "2026-10-06"), 5);
  assert.equal(daysBetween("2026-10-01T23:59:59Z", "2026-10-02T00:00:01Z"), 1);
  assert.equal(daysBetween("2026-10-06", "2026-10-01"), 0);
  assert.equal(averageDays([]), null);
  assert.equal(averageDays([1, 2]), 2); // 1.5 rounds up
  assert.equal(averageDays([3, 4, 4]), 4);
  const r = (amount_minor: string, received_on: string) => ({
    amount_minor,
    received_on,
  });
  assert.equal(
    paidOn("100", [r("40", "2026-10-03"), r("60", "2026-10-09")]),
    "2026-10-09",
  );
  assert.equal(paidOn("100", [r("40", "2026-10-03")]), null);
  assert.equal(paidOn(null, []), null);
  const base = {
    delivered: true,
    pod_accepted: true,
    packet_amount_minor: "100",
    packet_submitted: true,
    paid_minor: "0",
  };
  assert.deepEqual(cashStage({ ...base, delivered: false }), {
    stage: "not_delivered",
    waiting_on: null,
  });
  assert.deepEqual(cashStage({ ...base, pod_accepted: false }), {
    stage: "waiting_on_pod",
    waiting_on: "driver",
  });
  assert.deepEqual(cashStage({ ...base, packet_submitted: false }), {
    stage: "ready_for_packet",
    waiting_on: "dispatcher",
  });
  assert.deepEqual(cashStage(base), {
    stage: "awaiting_payment",
    waiting_on: "payer",
  });
  assert.deepEqual(cashStage({ ...base, paid_minor: "40" }), {
    stage: "partly_paid",
    waiting_on: "payer",
  });
  assert.deepEqual(cashStage({ ...base, paid_minor: "100" }), {
    stage: "paid",
    waiting_on: null,
  });
  // Sold to a factor: waiting on the factor, until it is paid in full.
  assert.deepEqual(cashStage({ ...base, factored: true }), {
    stage: "factored",
    waiting_on: "factor",
  });
  assert.equal(
    cashStage({ ...base, factored: true, paid_minor: "100" }).stage,
    "paid",
  );
});

test("each delivered load shows its stage, who it waits on, the fee state and the days", async () => {
  const noPod = await delivered();
  const ready = await delivered();
  await accept(ready.id);
  const awaiting = await delivered();
  await accept(awaiting.id);
  await submitted(awaiting.id, "AW-1");
  const partial = await delivered();
  await accept(partial.id);
  await submitted(partial.id, "PA-1");
  await receipt(partial.id, 100000, plusDays(2));
  const paid = await delivered();
  await accept(paid.id);
  await submitted(paid.id, "PD-1");
  await receipt(paid.id, 100000, plusDays(2));
  await receipt(paid.id, 150000, plusDays(5));
  const invoice = await createInvoice(t.dispatcher, {
    carrier_id: t.carrier,
    load_ids: [paid.id],
    fee_bps: 1000,
    due_on: plusDays(30),
    idempotency_key: randomUUID(),
  });
  // A load handed to the factor is waiting on the factor, not on the payer.
  const sold = await delivered();
  await accept(sold.id);
  await submitted(sold.id, "FC-1");
  const batchId = randomUUID();
  await pool.query(
    `INSERT INTO factoring_batches(id,carrier_id,factor_name,status,load_count,total_minor,file_sha256,file_csv,created_by,handed_off_at,handed_off_by,idempotency_key,request_hash)
     VALUES($1,$2,'Fictional Factor Co','handed_off',1,250000,repeat('a',64),'x',$3,now(),$3,$4,'h')`,
    [batchId, t.carrier, t.manager, randomUUID()],
  );
  await pool.query(
    "INSERT INTO factoring_batch_loads(batch_id,carrier_id,load_id,amount_minor) VALUES($1,$2,$3,250000)",
    [batchId, t.carrier, sold.id],
  );
  // A load that has not been delivered is not part of the cash picture.
  const booked = await bookedLoad(t.dispatcher, t.carrier);

  const asOf = plusDays(9);
  const view = await cashOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier, as_of: asOf }),
  );
  const by = (id: string) => view.loads.find((l) => l.id === id)!;
  assert.equal(
    view.loads.some((l) => l.id === booked.id),
    false,
  );
  assert.deepEqual(
    [by(noPod.id).cash_stage, by(noPod.id).waiting_on],
    ["waiting_on_pod", "driver"],
  );
  assert.deepEqual(
    [by(ready.id).cash_stage, by(ready.id).waiting_on],
    ["ready_for_packet", "dispatcher"],
  );
  const a = by(awaiting.id);
  assert.deepEqual(
    [a.cash_stage, a.waiting_on, a.payer],
    ["awaiting_payment", "payer", "Fictional Broker LLC"],
  );
  assert.equal(a.days.waiting, 9);
  assert.equal(a.owed_minor, "250000");
  const p = by(partial.id);
  assert.deepEqual(
    [p.cash_stage, p.paid_minor, p.owed_minor],
    ["partly_paid", "100000", "150000"],
  );
  const d = by(paid.id);
  assert.equal(d.cash_stage, "paid");
  assert.equal(d.paid_on, plusDays(5));
  assert.deepEqual(d.days, {
    delivery_to_submit: 0,
    submit_to_paid: 5,
    to_cash: 5,
    waiting: null,
  });
  // A fee on a draft invoice can still change, so it is a draft, not invoiced;
  // nothing else gets an invented net.
  assert.deepEqual(d.fee, {
    state: "draft",
    minor: "25000",
    bps: 1000,
    invoice_number: null,
  });
  assert.equal(d.net_minor, "225000");
  assert.deepEqual([a.fee.state, a.net_minor], ["unknown", null]);
  assert.equal(view.summary.net_loads, 1);
  assert.equal(view.summary.net_draft_loads, 1);
  assert.equal(view.summary.net_minor, "225000");
  // Once the invoice is issued the fee is real.
  await changeInvoice(t.dispatcher, invoice.id, {
    action: "issue",
    version: 1,
  });
  const issued = await cashOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier, as_of: asOf }),
  );
  const di = issued.loads.find((l) => l.id === paid.id)!;
  assert.equal(di.fee.state, "invoiced");
  assert.match(di.fee.invoice_number!, /^RLY-\d+$/);
  assert.equal(issued.summary.net_draft_loads, 0);
  // Sold to the factor: not "waiting on the payer", and not in "billed, not yet paid".
  const f = by(sold.id);
  assert.deepEqual(
    [f.cash_stage, f.waiting_on, f.owed_minor],
    ["factored", "factor", "250000"],
  );
  assert.deepEqual(
    [view.summary.with_factor_loads, view.summary.with_factor_minor],
    [1, "250000"],
  );
  // Delivered but not billed: two loads, their rate shown, and not counted as owed.
  assert.deepEqual(
    [view.summary.unbilled_loads, view.summary.unbilled_gross_minor],
    [2, "500000"],
  );
  assert.equal(view.summary.avg_days_to_cash, 5);
  assert.equal(view.summary.paid, 1);
  assert.equal(view.summary.oldest_waiting_days, 9);
  // Outstanding: the unpaid remainders of loads that have a packet.
  assert.equal(view.summary.outstanding_minor, (250000n + 150000n).toString());
  assert.equal(view.list_truncated, false);

  // A cut list says so and keeps the figures for every load read; a ceiling on
  // the loads read is reported too.
  const cut = await cashOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier, as_of: asOf }),
    { listLimit: 2 },
  );
  assert.deepEqual(
    [
      cut.loads.length,
      cut.list_truncated,
      cut.totals_partial,
      cut.summary.loads,
    ],
    [2, true, false, view.summary.loads],
  );
  assert.equal(cut.summary.net_minor, view.summary.net_minor);
  const partial2 = await cashOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier, as_of: asOf }),
    { readLimit: 3 },
  );
  assert.deepEqual(
    [partial2.totals_partial, partial2.summary.loads],
    [true, 3],
  );

  // Previewing a percentage labels the others as estimates and leaves the real fee alone.
  const preview = await cashOverview(
    t.manager,
    new URLSearchParams({ carrier_id: t.carrier, fee_bps: "800", as_of: asOf }),
  );
  const pa = preview.loads.find((l) => l.id === awaiting.id)!;
  assert.deepEqual(
    [pa.fee.state, pa.fee.minor, pa.net_minor],
    ["estimate", "20000", "230000"],
  );
  assert.equal(
    preview.loads.find((l) => l.id === paid.id)!.fee.state,
    "invoiced",
  );
});

test("HTTP: only people of the carrier see it, and bad input is refused", async () => {
  const call = async (path: string, user: string) => {
    const res = await GET(request(path, { token: await sessionFor(user) }));
    return res.status;
  };
  const path = "billing/cash?carrier_id=" + t.carrier;
  assert.equal(await call(path, t.dispatcher), 200);
  assert.equal(await call(path, t.manager), 200);
  for (const user of [t.driverUser, t.foreignManager])
    assert.equal(await call(path, user), 404);
  assert.equal(await call(path + "&fee_bps=10001", t.dispatcher), 400);
  assert.equal(await call(path + "&fee_bps=1.5", t.dispatcher), 400);
  assert.equal(await call(path + "&as_of=yesterday", t.dispatcher), 400);
  assert.equal(await call("billing/cash", t.dispatcher), 400);
});
