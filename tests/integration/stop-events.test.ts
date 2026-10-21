import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import {
  createLoad,
  detail,
  mutate,
  recordStopEvent,
} from "../../src/lib/loads";
import { stopTiming } from "../../src/lib/stop-timing";
import type { Load } from "../../src/lib/contracts";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Stops");
});
after(() => pool.end());

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();
/** Three stops with windows that closed 10h, 6h and 2h ago. */
async function route() {
  const stop = (kind: string, address: string, endedMinutesAgo: number) => ({
    kind,
    address,
    timezone: "America/Chicago",
    windowStart: ago(endedMinutesAgo + 60),
    windowEnd: ago(endedMinutesAgo),
  });
  const load = await createLoad(
    t.dispatcher,
    {
      carrierId: t.carrier,
      reference: "STOP-" + randomUUID().slice(0, 8),
      source: "Fictional stop tracking QA",
      amountMinor: 300000,
      stops: [
        stop("pickup", "Chicago, IL", 600),
        stop("delivery", "Indianapolis, IN", 360),
        stop("delivery", "Louisville, KY", 120),
      ],
    },
    randomUUID(),
  );
  const version = (
    await mutate(t.dispatcher, load.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  const view = (await detail(t.dispatcher, load.id)) as Load;
  return { load, version, stops: view.stops!.map((s) => s.id!) };
}
const report = (
  version: number,
  kind: "arrived" | "departed",
  occurred_at: string,
  extra: Record<string, unknown> = {},
) => ({ version, kind, occurred_at, idempotency_key: randomUUID(), ...extra });

test("arrivals and departures record dwell, lateness and history without changing the milestone", async () => {
  const { load, stops, version: assigned } = await route();
  let version = assigned;
  version = (
    await recordStopEvent(
      t.driverUser,
      load.id,
      stops[0],
      report(version, "arrived", ago(640)),
    )
  ).version;
  await assert.rejects(
    recordStopEvent(
      t.driverUser,
      load.id,
      stops[1],
      report(version, "departed", ago(300)),
    ),
    { code: "STOP_ARRIVAL_REQUIRED" },
  );
  await assert.rejects(
    recordStopEvent(
      t.driverUser,
      load.id,
      stops[0],
      report(version, "departed", ago(700)),
    ),
    { code: "STOP_TIME_ORDER" },
  );
  version = (
    await recordStopEvent(
      t.driverUser,
      load.id,
      stops[0],
      report(version, "departed", ago(470)),
    )
  ).version;
  // Arriving at stop 2 before leaving stop 1 would run backwards.
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[1],
      report(version, "arrived", ago(500)),
    ),
    { code: "STOP_TIME_ORDER" },
  );
  const key = randomUUID();
  const arrival = {
    ...report(version, "arrived", ago(330)),
    idempotency_key: key,
  };
  version = (await recordStopEvent(t.manager, load.id, stops[1], arrival))
    .version;
  assert.equal(
    (await recordStopEvent(t.manager, load.id, stops[1], arrival)).version,
    version,
  );
  await assert.rejects(
    recordStopEvent(t.manager, load.id, stops[1], {
      ...arrival,
      occurred_at: ago(320),
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  const view = (await detail(t.dispatcher, load.id)) as Load;
  assert.equal(view.stage, "booked");
  const first = view.stops![0];
  assert.equal(stopTiming(first).dwellMinutes, 170);
  assert.equal(stopTiming(first).lateMinutes, 0);
  assert.equal(stopTiming(view.stops![1]).lateMinutes, 30);
  assert.ok(
    view.exception_suggestions!.some((s) =>
      s.summary.startsWith("Arrived 30 min after the window at stop 2"),
    ),
  );
  assert.equal(first.arrived?.actor_name, "Stops Driver");
  const events = await pool.query(
    "SELECT type FROM load_events WHERE load_id=$1 AND type LIKE 'load.stop-%' ORDER BY created_at",
    [load.id],
  );
  assert.deepEqual(
    events.rows.map((r) => r.type),
    ["load.stop-arrived", "load.stop-departed", "load.stop-arrived"],
  );
});

test("corrections must name the current report and give a reason; history is kept", async () => {
  const { load, stops } = await route();
  let version = 2;
  const first = await recordStopEvent(
    t.manager,
    load.id,
    stops[0],
    report(version, "arrived", ago(650)),
  );
  version = first.version;
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[0],
      report(version, "arrived", ago(640)),
    ),
    { code: "STOP_EVENT_EXISTS" },
  );
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[0],
      report(version, "arrived", ago(640), { supersedes: first.stop_event_id }),
    ),
    { name: "ZodError" },
  );
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[0],
      report(version, "arrived", ago(640), {
        supersedes: randomUUID(),
        reason: "x",
      }),
    ),
    { code: "STOP_EVENT_CHANGED" },
  );
  const fixed = await recordStopEvent(
    t.driverUser,
    load.id,
    stops[0],
    report(version, "arrived", ago(640), {
      supersedes: first.stop_event_id,
      reason: "Entered the gate time, not the check-in time",
    }),
  );
  // A second correction of the original (not the latest) is refused.
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[0],
      report(fixed.version, "arrived", ago(630), {
        supersedes: first.stop_event_id,
        reason: "stale",
      }),
    ),
    { code: "STOP_EVENT_CHANGED" },
  );
  const stop = ((await detail(t.manager, load.id)) as Load).stops![0];
  assert.equal(stop.arrived?.id, fixed.stop_event_id);
  assert.equal(
    stop.arrived?.reason,
    "Entered the gate time, not the check-in time",
  );
  assert.equal(stop.stop_events?.length, 2);
  await assert.rejects(
    pool.query("UPDATE stop_events SET note='x' WHERE id=$1", [
      fixed.stop_event_id,
    ]),
    /Append-only record/,
  );
});

test("stop reporting is scoped to the carrier, the assigned driver and the load's own stops", async () => {
  const { load, stops } = await route();
  const other = await route();
  const body = () => report(2, "arrived", ago(650));
  await assert.rejects(
    recordStopEvent(t.otherDriverUser, load.id, stops[0], body()),
    {
      code: "NOT_FOUND",
    },
  );
  await assert.rejects(
    recordStopEvent(t.foreignManager, load.id, stops[0], body()),
    {
      code: "NOT_FOUND",
    },
  );
  // A stop ID from another load is not found on this one.
  await assert.rejects(
    recordStopEvent(t.manager, load.id, other.stops[0], body()),
    {
      code: "NOT_FOUND",
    },
  );
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[0],
      report(2, "arrived", new Date(Date.now() + 3600000).toISOString()),
    ),
    { code: "STOP_TIME_OUT_OF_RANGE" },
  );
  await assert.rejects(
    recordStopEvent(
      t.manager,
      load.id,
      stops[0],
      report(1, "arrived", ago(650)),
    ),
    {
      code: "VERSION_CONFLICT",
    },
  );
  const token = await sessionFor(t.foreignManager);
  const denied = await POST(
    request(`loads/${load.id}/stops/${stops[0]}/events`, {
      token,
      json: body(),
    }),
  );
  assert.equal(denied.status, 404);
});
