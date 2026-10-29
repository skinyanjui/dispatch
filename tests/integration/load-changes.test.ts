import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import {
  detail,
  listLoads,
  mutate,
  recordStopEvent,
} from "../../src/lib/loads";
import { decideChange } from "../../src/lib/change-control";
import { cancelLoad, editLoad } from "../../src/lib/load-changes";
import { openException } from "../../src/lib/exceptions";
import {
  bookedLoad,
  request,
  sessionFor,
  tenant,
  withPassword,
} from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Changes");
});
after(() => pool.end());

const assigned = async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.driver,
  });
  return load;
};
const queued = async (like: string) =>
  (
    await pool.query(
      "SELECT subject FROM notifications WHERE recipient_user_id=$1 AND subject LIKE $2",
      [t.driverUser, like],
    )
  ).rowCount ?? 0;

test("a booked load can be corrected; every change keeps the old value", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const d = await detail(t.dispatcher, load.id);
  const pickup = d.stops[0];
  const saved = await editLoad(t.dispatcher, load.id, {
    version: d.version,
    amountMinor: 262500,
    source: "Corrected source",
    stops: [{ id: pickup.id, address: "Chicago, IL 60601" }],
  });
  assert.equal(saved.version, d.version + 1);
  const after = await detail(t.dispatcher, load.id);
  assert.equal(after.amount_minor, "262500");
  assert.equal(after.stops[0].address, "Chicago, IL 60601");
  const fields = after.changes.map((c: { field: string }) => c.field).sort();
  assert.deepEqual(fields, ["address", "amount_minor", "source"]);
  const amount = after.changes.find(
    (c: { field: string }) => c.field === "amount_minor",
  );
  assert.equal(amount.old_value, "250000");
  assert.equal(amount.new_value, "262500");
  // History cannot be rewritten.
  await assert.rejects(
    pool.query("UPDATE load_changes SET new_value='x' WHERE load_id=$1", [
      load.id,
    ]),
  );
  // Stale version, empty edits and foreign stops are refused.
  await assert.rejects(
    editLoad(t.dispatcher, load.id, { version: d.version, source: "Again" }),
    { code: "VERSION_CONFLICT" },
  );
  await assert.rejects(
    editLoad(t.dispatcher, load.id, {
      version: saved.version,
      source: "Corrected source",
    }),
    { code: "NO_CHANGES" },
  );
  const other = await bookedLoad(t.dispatcher, t.carrier);
  const otherStop = (await detail(t.dispatcher, other.id)).stops[0];
  await assert.rejects(
    editLoad(t.dispatcher, load.id, {
      version: saved.version,
      stops: [{ id: otherStop.id, address: "Somewhere else" }],
    }),
    { code: "NOT_FOUND" },
  );
});

test("edits keep stops in order, references unique, and need a reason once dispatched", async () => {
  const load = await assigned();
  const d = await detail(t.dispatcher, load.id);
  await assert.rejects(
    editLoad(t.dispatcher, load.id, {
      version: d.version,
      stops: [
        {
          id: d.stops[1].id,
          windowStart: new Date(d.stops[0].window_start).toISOString(),
          windowEnd: new Date(d.stops[0].window_start).toISOString(),
        },
      ],
    }),
    { code: "INVALID_STOP_WINDOWS" },
  );
  const taken = await bookedLoad(t.dispatcher, t.carrier);
  await assert.rejects(
    editLoad(t.dispatcher, load.id, {
      version: d.version,
      reference: taken.reference,
    }),
    { code: "REFERENCE_TAKEN" },
  );
  // Same reference in another carrier is allowed (unique per carrier).
  const stage = await mutate(t.dispatcher, load.id, "milestones", {
    version: d.version,
    stage: "dispatched",
  });
  await assert.rejects(
    editLoad(t.dispatcher, load.id, { version: stage.version, source: "New" }),
    { code: "REASON_REQUIRED" },
  );
  const before = await queued("Load % was updated");
  // A new address after dispatch is a reroute: it waits for a second person
  // (ADR 0064), and the driver is told only once it is approved.
  const held = (await editLoad(t.dispatcher, load.id, {
    version: stage.version,
    reason: "Shipper moved the dock",
    stops: [{ id: d.stops[0].id, address: "Chicago, IL (Dock 4)" }],
  })) as { pending_approval?: boolean; change_id?: string };
  assert.equal(held.pending_approval, true);
  assert.equal((await queued("Load % was updated")) - before, 0);
  await decideChange(t.manager, held.change_id!, {
    decision: "approve",
    verification: "callback",
    password: await withPassword(t.manager),
  });
  assert.equal((await queued("Load % was updated")) - before, 1);
  // Money-only edits do not page the driver.
  const v = (await detail(t.dispatcher, load.id)).version;
  await editLoad(t.dispatcher, load.id, {
    version: v,
    reason: "Rate fix",
    amountMinor: 1,
  });
  assert.equal((await queued("Load % was updated")) - before, 1);
  // A stop with a recorded arrival is locked.
  const now = (await detail(t.dispatcher, load.id)).version;
  await recordStopEvent(t.dispatcher, load.id, d.stops[0].id, {
    version: now,
    kind: "arrived",
    occurred_at: new Date().toISOString(),
    idempotency_key: randomUUID(),
  });
  await assert.rejects(
    editLoad(t.dispatcher, load.id, {
      version: (await detail(t.dispatcher, load.id)).version,
      reason: "Late fix",
      stops: [{ id: d.stops[0].id, address: "Elsewhere" }],
    }),
    { code: "STOP_ALREADY_STARTED" },
  );
});

test("cancelling needs a reason, closes exceptions, tells the driver and freezes the load", async () => {
  const load = await assigned();
  const d = await detail(t.dispatcher, load.id);
  await openException(t.dispatcher, load.id, {
    idempotency_key: randomUUID(),
    type: "delay",
    severity: "low",
    summary: "Weather",
  });
  await assert.rejects(
    cancelLoad(t.dispatcher, load.id, { version: d.version, reason: "" }),
  );
  const before = await queued("Load % was cancelled");
  const done = await cancelLoad(t.dispatcher, load.id, {
    version: (await detail(t.dispatcher, load.id)).version,
    reason: "Broker withdrew the load",
  });
  assert.equal((await queued("Load % was cancelled")) - before, 1);
  const after = await detail(t.dispatcher, load.id);
  assert.ok(after.cancelled_at);
  assert.equal(after.cancel_reason, "Broker withdrew the load");
  assert.ok(
    after.exceptions.every((e: { status: string }) => e.status === "resolved"),
  );
  // Frozen: no edits, milestones or second cancel.
  await assert.rejects(
    editLoad(t.dispatcher, load.id, {
      version: done.version,
      reason: "x",
      source: "x",
    }),
    { code: "LOAD_CANCELLED" },
  );
  await assert.rejects(
    mutate(t.dispatcher, load.id, "milestones", {
      version: done.version,
      stage: "dispatched",
    }),
    { code: "LOAD_CANCELLED" },
  );
  await assert.rejects(
    cancelLoad(t.dispatcher, load.id, {
      version: done.version,
      reason: "again",
    }),
    { code: "LOAD_CANCELLED" },
  );
  // Queues: hidden from active views, shown under Cancelled.
  const active = await listLoads(
    t.dispatcher,
    new URLSearchParams({ carrier_id: t.carrier }),
  );
  assert.ok(!active.loads.some((l: { id: string }) => l.id === load.id));
  const gone = await listLoads(
    t.dispatcher,
    new URLSearchParams({ carrier_id: t.carrier, status: "cancelled" }),
  );
  assert.ok(gone.loads.some((l: { id: string }) => l.id === load.id));
});

test("loads already picked up cannot be cancelled; delivered loads are locked", async () => {
  const load = await assigned();
  let v = load.version + 1;
  for (const stage of ["dispatched", "picked-up"]) {
    v = (
      await mutate(t.dispatcher, load.id, "milestones", { version: v, stage })
    ).version;
  }
  await assert.rejects(
    cancelLoad(t.dispatcher, load.id, { version: v, reason: "Too late" }),
    { code: "CANNOT_CANCEL_STARTED" },
  );
  v = (
    await mutate(t.dispatcher, load.id, "milestones", {
      version: v,
      stage: "delivered",
    })
  ).version;
  await assert.rejects(
    editLoad(t.dispatcher, load.id, { version: v, reason: "x", source: "x" }),
    { code: "LOAD_LOCKED" },
  );
});

test("drivers and other tenants cannot edit or cancel", async () => {
  const load = await assigned();
  const v = (await detail(t.dispatcher, load.id)).version;
  for (const user of [t.driverUser, t.foreignManager]) {
    await assert.rejects(
      editLoad(user, load.id, { version: v, source: "Hacked" }),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(
      cancelLoad(user, load.id, { version: v, reason: "Hacked" }),
      { code: "NOT_FOUND" },
    );
  }
  const token = await sessionFor(t.foreignManager);
  const response = await POST(
    request(`loads/${load.id}/cancel`, {
      token,
      json: { version: v, reason: "Hacked" },
    }),
  );
  assert.equal(response.status, 404);
  assert.equal((await detail(t.dispatcher, load.id)).cancelled_at, null);
});
