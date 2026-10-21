import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  listExceptions,
  openException,
  updateException,
} from "../../src/lib/exceptions";
import { detail, mutate } from "../../src/lib/loads";
import { suggestExceptions } from "../../src/lib/exception-rules";
import type { Load } from "../../src/lib/contracts";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Exceptions");
});
after(() => pool.end());

const delay = (extra: Record<string, unknown> = {}) => ({
  type: "delay",
  severity: "high",
  summary: "Driver held at shipper",
  idempotency_key: randomUUID(),
  ...extra,
});

test("suggestions use recorded milestones, windows and documents only", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const stops = [
    { kind: "pickup", window_end: "2026-10-21T10:00:00Z" },
    { kind: "delivery", window_end: "2026-10-22T10:00:00Z" },
  ];
  const booked = suggestExceptions({ stage: "dispatched", stops }, now);
  assert.deepEqual(
    booked.map((s) => [s.type, s.document_type]),
    [
      ["missed_appointment", null],
      ["missing_document", "rate_confirmation"],
    ],
  );
  const delivered = suggestExceptions(
    {
      stage: "delivered",
      stops,
      exceptions: [
        { type: "missing_document", status: "open", document_type: "pod" },
      ],
    },
    now,
  );
  assert.deepEqual(
    delivered.map((s) => s.document_type),
    ["rate_confirmation", "bol"],
  );
});

test("exception lifecycle: open, assign, start, resolve, reopen with versions and events", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const key = randomUUID();
  const opened = await openException(t.manager, load.id, {
    ...delay(),
    idempotency_key: key,
    owner_id: t.dispatcher,
    due_at: new Date(Date.now() - 60000).toISOString(),
  });
  const retry = await openException(t.manager, load.id, {
    ...delay(),
    idempotency_key: key,
    owner_id: t.dispatcher,
    due_at: undefined,
  }).catch((e) => e);
  assert.equal(retry.code, "IDEMPOTENCY_CONFLICT");
  await assert.rejects(
    openException(t.manager, load.id, delay({ owner_id: t.driverUser })),
    { code: "OWNER_NOT_ELIGIBLE" },
  );
  await assert.rejects(
    openException(t.manager, load.id, delay({ owner_id: t.foreignManager })),
    { code: "OWNER_NOT_ELIGIBLE" },
  );
  const mine = await listExceptions(
    t.dispatcher,
    new URLSearchParams({ owner: "me", overdue: "true" }),
  );
  assert.ok(mine.exceptions.some((e) => e.id === opened.id));
  let v = 1;
  await assert.rejects(
    updateException(t.manager, opened.id, {
      action: "reopen",
      version: v,
      reason: "x",
    }),
    { code: "INVALID_TRANSITION" },
  );
  v = (
    await updateException(t.manager, opened.id, { action: "start", version: v })
  ).version;
  await assert.rejects(
    updateException(t.manager, opened.id, { action: "start", version: 1 }),
    { code: "VERSION_CONFLICT" },
  );
  v = (
    await updateException(t.dispatcher, opened.id, {
      action: "assign",
      version: v,
      owner_id: t.manager,
    })
  ).version;
  // A milestone change never closes or hides the exception.
  await mutate(t.dispatcher, load.id, "assign", {
    version: 1,
    driverId: t.driver,
  });
  v = (
    await updateException(t.manager, opened.id, {
      action: "resolve",
      version: v,
      resolution: "Shipper loaded at 14:10; receiver notified",
    })
  ).version;
  await assert.rejects(
    updateException(t.manager, opened.id, {
      action: "assign",
      version: v,
      owner_id: null,
    }),
    { code: "EXCEPTION_RESOLVED" },
  );
  v = (
    await updateException(t.dispatcher, opened.id, {
      action: "reopen",
      version: v,
      reason: "Receiver reports the appointment was missed",
    })
  ).version;
  assert.equal(v, 5);
  const view = (await detail(t.dispatcher, load.id)) as Load;
  const item = view.exceptions!.find((e) => e.id === opened.id)!;
  assert.equal(item.status, "open");
  assert.equal(item.resolution, null);
  assert.equal(item.owner_name, "Exceptions Manager");
  assert.ok(view.exception_owners!.some((o) => o.id === t.manager));
  assert.ok(!view.exception_owners!.some((o) => o.id === t.driverUser));
  const events = await pool.query(
    "SELECT type FROM load_events WHERE load_id=$1 AND type LIKE 'exception.%' ORDER BY created_at",
    [load.id],
  );
  assert.deepEqual(
    events.rows.map((r) => r.type),
    [
      "exception.opened",
      "exception.started",
      "exception.assigned",
      "exception.resolved",
      "exception.reopened",
    ],
  );
});

test("drivers report on assigned loads only and cannot manage exceptions", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: 1,
    driverId: t.driver,
  });
  const reported = await openException(t.driverUser, load.id, delay());
  await assert.rejects(
    openException(t.driverUser, load.id, delay({ owner_id: t.dispatcher })),
    { code: "ROLE_NOT_PERMITTED" },
  );
  await assert.rejects(openException(t.otherDriverUser, load.id, delay()), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    updateException(t.driverUser, reported.id, { action: "start", version: 1 }),
    { code: "NOT_FOUND" },
  );
  const driverQueue = await listExceptions(t.driverUser, new URLSearchParams());
  assert.ok(driverQueue.exceptions.some((e) => e.id === reported.id));
  const otherQueue = await listExceptions(
    t.otherDriverUser,
    new URLSearchParams(),
  );
  assert.ok(!otherQueue.exceptions.some((e) => e.id === reported.id));
});

test("exceptions are carrier-isolated, including guessed IDs over HTTP", async () => {
  const foreign = await bookedLoad(t.dispatcher, t.foreign);
  const foreignException = await openException(
    t.foreignManager,
    foreign.id,
    delay(),
  );
  await assert.rejects(openException(t.manager, foreign.id, delay()), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    updateException(t.manager, foreignException.id, {
      action: "start",
      version: 1,
    }),
    { code: "NOT_FOUND" },
  );
  const queue = await listExceptions(
    t.manager,
    new URLSearchParams({ status: "all" }),
  );
  assert.ok(queue.exceptions.every((e) => e.carrier_id === t.carrier));
  const token = await sessionFor(t.manager);
  const denied = await POST(
    request("exceptions/" + foreignException.id, {
      token,
      json: { action: "start", version: 1 },
    }),
  );
  assert.equal(denied.status, 404);
  const invalid = await POST(
    request("loads/" + foreign.id + "/exceptions", {
      token,
      json: { ...delay(), type: "weather" },
    }),
  );
  assert.equal(invalid.status, 400);
  const list = await GET(request("exceptions?status=bogus", { token }));
  assert.equal(list.status, 400);
  const mismatch = await POST(
    request("loads/" + foreign.id + "/exceptions", {
      token,
      json: delay({ type: "missing_document" }),
    }),
  );
  assert.equal(mismatch.status, 400);
});
