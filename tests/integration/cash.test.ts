import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import {
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
  await createInvoice(t.dispatcher, {
    carrier_id: t.carrier,
    load_ids: [paid.id],
    fee_bps: 1000,
    due_on: plusDays(30),
    idempotency_key: randomUUID(),
  });
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
  // Only the invoiced load has a real fee; nothing else gets an invented net.
  assert.deepEqual(d.fee, {
    state: "invoiced",
    minor: "25000",
    bps: 1000,
    invoice_number: null,
  });
  assert.equal(d.net_minor, "225000");
  assert.deepEqual([a.fee.state, a.net_minor], ["unknown", null]);
  assert.equal(view.summary.net_loads, 1);
  assert.equal(view.summary.net_minor, "225000");
  assert.equal(view.summary.avg_days_to_cash, 5);
  assert.equal(view.summary.paid, 1);
  assert.equal(view.summary.oldest_waiting_days, 9);
  // Outstanding: the unpaid remainders of loads that have a packet.
  assert.equal(view.summary.outstanding_minor, (250000n + 150000n).toString());

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
