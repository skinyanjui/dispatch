import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import { attentionLoads, listLoads, mutate } from "../../src/lib/loads";
import { uploadDocument } from "../../src/lib/documents";
import { openException } from "../../src/lib/exceptions";
import { cancelLoad } from "../../src/lib/load-changes";
import { summarize, span, type AttentionInput } from "../../src/lib/attention";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Attention");
});
after(() => pool.end());

const hour = 3_600_000;
const now = Date.parse("2026-11-05T12:00:00Z");
const stop = (kind: string, startH: number, endH = startH + 1) => ({
  kind,
  address: kind + " city",
  timezone: "America/Chicago",
  window_start: new Date(now + startH * hour).toISOString(),
  window_end: new Date(now + endH * hour).toISOString(),
});
const base = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  stage: "booked",
  cancelled: false,
  driver_name: "Jordan Ellis",
  stops: [stop("pickup", 30), stop("delivery", 54)],
  docs: { rate_confirmation: "accepted", bol: "missing", pod: "missing" },
  exceptions: [],
  ...over,
});
const keys = (input: AttentionInput) =>
  summarize(input, now).attention.reasons.map((r) => r.key);

test("a load with a driver, time and paperwork in order needs nothing", () => {
  const s = summarize(base(), now);
  assert.equal(s.attention.level, "ok");
  assert.equal(s.attention.next_step, "Ready to dispatch");
  assert.equal(s.next?.label, "Pickup");
  assert.equal(s.docs.accepted, 1);
});

test("missing driver, closing appointments and lateness are named plainly", () => {
  assert.deepEqual(keys(base({ driver_name: null })), ["no_driver"]);
  const soon = summarize(
    base({ stops: [stop("pickup", 2), stop("delivery", 30)] }),
    now,
  );
  assert.equal(soon.attention.level, "soon");
  assert.equal(soon.attention.next_step, "Pickup in 2h");
  const open = summarize(
    base({ stops: [stop("pickup", -1, 1), stop("delivery", 30)] }),
    now,
  );
  assert.equal(open.attention.next_step, "Pickup window is open");
  const late = summarize(
    base({ stops: [stop("pickup", -6, -4), stop("delivery", 30)] }),
    now,
  );
  assert.equal(late.attention.level, "late");
  assert.equal(late.attention.next_step, "Pickup was due 4h ago");
  // Arriving, or leaving, ends the worry about that stop.
  const arrived = base({
    stops: [
      { ...stop("pickup", -6, -4), arrived: { at: 1 } },
      stop("delivery", 30),
    ],
  });
  assert.equal(summarize(arrived, now).attention.level, "ok");
  assert.equal(summarize(arrived, now).next?.arrived, true);
});

test("milestones move the next stop and cancelled loads are quiet", () => {
  const pickedUp = base({
    stage: "picked-up",
    stops: [stop("pickup", -6, -4), stop("delivery", 20)],
  });
  assert.equal(summarize(pickedUp, now).next?.label, "Delivery");
  assert.ok(
    !keys(pickedUp).includes("late"),
    "past pickup is not late once picked up",
  );
  assert.deepEqual(keys(base({ cancelled: true, driver_name: null })), []);
});

test("paperwork is expected as the load moves, and rejections always show", () => {
  const delivered = base({
    stage: "delivered",
    stops: [stop("pickup", -30), stop("delivery", -6)],
    docs: { rate_confirmation: "accepted", bol: "accepted", pod: "missing" },
  });
  const s = summarize(delivered, now);
  assert.deepEqual(
    s.attention.reasons.map((r) => r.text),
    ["Proof of delivery is missing"],
  );
  assert.equal(
    summarize(
      {
        ...delivered,
        docs: {
          rate_confirmation: "accepted",
          bol: "accepted",
          pod: "accepted",
        },
      },
      now,
    ).attention.next_step,
    "Delivered, paperwork complete",
  );
  assert.deepEqual(
    summarize(
      base({
        docs: { rate_confirmation: "rejected", bol: "missing", pod: "missing" },
      }),
      now,
    ).attention.reasons.map((r) => r.text),
    ["Rate confirmation was rejected"],
  );
  assert.deepEqual(
    summarize(
      base({
        docs: {
          rate_confirmation: "pending_review",
          bol: "missing",
          pod: "missing",
        },
      }),
      now,
    ).attention.reasons.map((r) => r.text),
    ["Review the rate confirmation"],
  );
});

test("exceptions: overdue ones are late, the rest are counted", () => {
  const overdue = base({
    exceptions: [{ due_at: new Date(now - hour).toISOString() }],
  });
  assert.equal(summarize(overdue, now).attention.level, "late");
  const open = summarize(
    base({ exceptions: [{ due_at: null }, { due_at: null }] }),
    now,
  );
  assert.equal(open.attention.next_step, "2 open exceptions");
  assert.equal(open.exceptions.open, 2);
  assert.equal(span(20 * 60_000), "20 min");
  assert.equal(span(3 * hour + 10 * 60_000), "3h 10m");
  assert.equal(span(72 * hour), "3 days");
});

test("the list carries each load's answers and they follow the data", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: 2,
  });
  const row = async () =>
    (await listLoads(t.dispatcher, new URLSearchParams({ q: load.reference })))
      .loads[0];
  let found = await row();
  assert.equal(found.summary.driver_name, null);
  assert.deepEqual(
    found.summary.attention.reasons.map((r: { key: string }) => r.key).sort(),
    ["no_driver", "soon"],
  );
  assert.equal(found.summary.next.label, "Pickup");
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.driver,
  });
  found = await row();
  assert.equal(found.summary.driver_name !== null, true);
  assert.deepEqual(
    found.summary.attention.reasons.map((r: { key: string }) => r.key),
    ["soon"],
  );
  // A file waiting for review is called out; an open exception is counted.
  await uploadDocument(
    t.dispatcher,
    {
      idempotency_key: randomUUID(),
      carrier_id: t.carrier,
      type: "rate_confirmation",
      load_id: load.id,
    },
    { name: "rc.pdf", bytes: pdf() },
  );
  await openException(t.dispatcher, load.id, {
    idempotency_key: randomUUID(),
    type: "delay",
    severity: "low",
    summary: "Weather",
  });
  found = await row();
  const texts = found.summary.attention.reasons.map(
    (r: { text: string }) => r.text,
  );
  assert.ok(texts.includes("Review the rate confirmation"));
  assert.ok(texts.includes("1 open exception"));
  assert.equal(found.summary.docs.pending, 1);
});

test("the attention list is scoped, ordered and drops cancelled loads", async () => {
  const late = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -6,
  });
  const quiet = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: 200,
  });
  await mutate(t.dispatcher, quiet.id, "assign", {
    version: quiet.version,
    driverId: t.driver,
  });
  const gone = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -8,
  });
  await cancelLoad(t.dispatcher, gone.id, {
    version: gone.version,
    reason: "Not needed",
  });
  const board = await attentionLoads(t.dispatcher, new URLSearchParams());
  const ids = board.loads.map((l: { id: string }) => l.id);
  assert.ok(ids.includes(late.id));
  assert.ok(!ids.includes(quiet.id), "a load in order is not flagged");
  assert.ok(!ids.includes(gone.id), "cancelled loads are not flagged");
  const levels = board.loads.map(
    (l: { summary: { attention: { level: string } } }) =>
      l.summary.attention.level,
  );
  assert.deepEqual(
    levels,
    [...levels].sort(
      (a, b) =>
        ["late", "soon", "attention"].indexOf(a) -
        ["late", "soon", "attention"].indexOf(b),
    ),
  );
  assert.ok(board.counts.late >= 1);
  assert.equal(board.total, board.loads.length);
  // Other tenants see none of it, by list, by scope filter, or over HTTP.
  const foreign = await attentionLoads(t.foreignManager, new URLSearchParams());
  assert.ok(!foreign.loads.some((l: { id: string }) => ids.includes(l.id)));
  const guessed = await attentionLoads(
    t.foreignManager,
    new URLSearchParams({ carrier_id: t.carrier }),
  );
  assert.equal(guessed.loads.length, 0);
  assert.equal(guessed.total, 0);
  const token = await sessionFor(t.foreignManager);
  const http = await GET(
    request(`loads/attention?carrier_id=${t.carrier}`, { token }),
  );
  assert.equal(http.status, 200);
  assert.equal((await http.json()).loads.length, 0);
  assert.equal((await GET(request("loads/attention"))).status, 401);
  // A driver sees only loads assigned to them.
  const mine = await attentionLoads(t.driverUser, new URLSearchParams());
  assert.ok(mine.loads.every((l: { id: string }) => l.id !== late.id));
});
