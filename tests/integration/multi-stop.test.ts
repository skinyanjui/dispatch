import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import {
  createLoad,
  createSchema,
  detail,
  listLoads,
} from "../../src/lib/loads";
import { suggestExceptions } from "../../src/lib/exception-rules";
import type { Load } from "../../src/lib/contracts";
import { tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Multi-stop");
});
after(() => pool.end());

const stop = (kind: string, address: string, hour: number) => ({
  kind,
  address,
  timezone: "America/Chicago",
  windowStart: new Date(Date.UTC(2026, 10, 10, hour)).toISOString(),
  windowEnd: new Date(Date.UTC(2026, 10, 10, hour + 1)).toISOString(),
});
const input = (stops: ReturnType<typeof stop>[]) => ({
  carrierId: t.carrier,
  reference: "MS-" + randomUUID().slice(0, 8),
  source: "Fictional multi-stop QA",
  amountMinor: 410000,
  stops,
});

test("loads accept 2–10 ordered stops starting with a pickup and ending with a delivery", () => {
  const ok = [
    stop("pickup", "Chicago, IL", 1),
    stop("pickup", "Gary, IN", 3),
    stop("delivery", "Indianapolis, IN", 6),
    stop("delivery", "Louisville, KY", 9),
  ];
  assert.ok(createSchema.safeParse(input(ok)).success);
  const invalid = [
    [stop("delivery", "A", 1), stop("delivery", "B", 3)],
    [stop("pickup", "A", 1), stop("pickup", "B", 3)],
    [
      stop("pickup", "A", 5),
      stop("delivery", "B", 3),
      stop("delivery", "C", 7),
    ],
    Array.from({ length: 11 }, (_, i) =>
      stop(i === 10 ? "delivery" : "pickup", "Stop " + i, i * 2),
    ),
  ];
  for (const stops of invalid)
    assert.equal(createSchema.safeParse(input(stops)).success, false);
  const ten = Array.from({ length: 10 }, (_, i) =>
    stop(i === 9 ? "delivery" : "pickup", "Stop " + i, i * 2),
  );
  assert.ok(createSchema.safeParse(input(ten)).success);
});

test("multi-stop loads persist order and show first pickup, final delivery and count", async () => {
  const created = await createLoad(
    t.dispatcher,
    input([
      stop("pickup", "Chicago, IL", 1),
      stop("delivery", "Indianapolis, IN", 6),
      stop("pickup", "Columbus, OH", 10),
      stop("delivery", "Pittsburgh, PA", 15),
    ]),
    randomUUID(),
  );
  const view = (await detail(t.manager, created.id)) as Load;
  assert.deepEqual(
    view.stops!.map((s) => [s.kind, s.address]),
    [
      ["pickup", "Chicago, IL"],
      ["delivery", "Indianapolis, IN"],
      ["pickup", "Columbus, OH"],
      ["delivery", "Pittsburgh, PA"],
    ],
  );
  const queue = await listLoads(
    t.manager,
    new URLSearchParams({ q: created.reference }),
  );
  assert.equal(queue.loads[0].pickup, "Chicago, IL");
  assert.equal(queue.loads[0].delivery, "Pittsburgh, PA");
  assert.equal(queue.loads[0].stop_count, 4);
});

test("missed-appointment suggestions use the first pickup and the final delivery", () => {
  const stops = [
    { kind: "pickup", window_end: "2026-11-10T02:00:00Z" },
    { kind: "delivery", window_end: "2026-11-10T07:00:00Z" },
    { kind: "delivery", window_end: "2026-11-12T07:00:00Z" },
  ];
  const now = Date.parse("2026-11-11T00:00:00Z");
  // An intermediate window passing is flagged for that stop only, never as a
  // missed final delivery; a recorded arrival clears it.
  const summaries = suggestExceptions({ stage: "picked-up", stops }, now).map(
    (s) => s.summary,
  );
  assert.ok(
    summaries.includes("Window ended without a recorded arrival at stop 2"),
  );
  assert.ok(!summaries.some((s) => s.startsWith("Delivery window ended")));
  const arrived = stops.map((s, i) =>
    i === 1 ? { ...s, arrived: { occurred_at: "2026-11-10T06:30:00Z" } } : s,
  );
  assert.ok(
    !suggestExceptions({ stage: "picked-up", stops: arrived }, now).some(
      (s) => s.type === "missed_appointment",
    ),
  );
  assert.ok(
    suggestExceptions(
      { stage: "picked-up", stops },
      Date.parse("2026-11-13T00:00:00Z"),
    ).some((s) => s.summary.startsWith("Delivery window ended")),
  );
});
