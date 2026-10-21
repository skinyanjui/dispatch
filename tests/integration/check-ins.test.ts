import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { pool } from "../../src/lib/db";
import { digest } from "../../src/lib/auth";
import { POST } from "../../src/app/api/[...path]/route";
import {
  checkInSchema,
  createLoad,
  detail,
  mutate,
  recordCheckIn,
} from "../../src/lib/loads";

const dispatcher = randomUUID(),
  manager = randomUUID(),
  driverUser = randomUUID(),
  otherDriverUser = randomUUID(),
  carrier = randomUUID(),
  foreignCarrier = randomUUID(),
  driver = randomUUID(),
  otherDriver = randomUUID();

before(async () => {
  const organization = randomUUID();
  await pool.query("INSERT INTO organizations VALUES($1,'Check-in QA')", [
    organization,
  ]);
  for (const id of [carrier, foreignCarrier]) {
    await pool.query(
      "INSERT INTO carriers VALUES($1,$2,'Check-in carrier QA')",
      [id, organization],
    );
    await pool.query(
      "INSERT INTO carrier_dispatch_authorizations VALUES($1,$2,'Fictional QA agreement',now(),now()-interval '1 day',now()+interval '1 year')",
      [randomUUID(), id],
    );
  }
  for (const [id, name] of [
    [dispatcher, "Check-in dispatcher"],
    [manager, "Check-in manager"],
    [driverUser, "Check-in driver"],
    [otherDriverUser, "Other driver"],
  ])
    await pool.query(
      "INSERT INTO users VALUES($1,$2,'not-a-login-fixture',$3)",
      [id, id + "@relay.test", name],
    );
  for (const [user, carrierId, role] of [
    [dispatcher, carrier, "dispatcher"],
    [dispatcher, foreignCarrier, "dispatcher"],
    [manager, carrier, "carrier-manager"],
  ])
    await pool.query("INSERT INTO memberships VALUES($1,$2,$3,NULL)", [
      user,
      carrierId,
      role,
    ]);
  for (const [id, user] of [
    [driver, driverUser],
    [otherDriver, otherDriverUser],
  ]) {
    await pool.query("INSERT INTO drivers VALUES($1,$2,'Check-in driver QA')", [
      id,
      carrier,
    ]);
    await pool.query("INSERT INTO memberships VALUES($1,$2,'driver',$3)", [
      user,
      carrier,
      id,
    ]);
  }
});
after(() => pool.end());

async function load(carrierId = carrier) {
  return createLoad(
    dispatcher,
    {
      carrierId,
      reference: "CHECK-IN-" + randomUUID(),
      source: "Fictional check-in QA",
      amountMinor: 10000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: "2026-11-01T10:00:00Z",
          windowEnd: "2026-11-01T11:00:00Z",
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: "2026-11-02T10:00:00Z",
          windowEnd: "2026-11-02T11:00:00Z",
        },
      ],
    },
    randomUUID(),
  );
}
function observation(version = 1) {
  return {
    version,
    location: "  Joliet, IL  ",
    note: "  Driver reported a rest stop.  ",
    observed_at: new Date(Date.now() - 60_000).toISOString(),
    idempotency_key: randomUUID(),
  };
}

test("manual check-ins preserve provenance and event time without changing milestones", async () => {
  const l = await load();
  const data = observation();
  const result = await recordCheckIn(dispatcher, l.id, data);
  assert.equal(result.version, 2);
  const d = await detail(manager, l.id);
  assert.equal(d.stage, "booked");
  assert.equal(d.version, 2);
  assert.equal(d.check_ins.length, 1);
  const ci = d.check_ins[0];
  assert.equal(ci.id, result.check_in_id);
  assert.equal(ci.source, "manual");
  assert.equal(ci.actor_name, "Check-in dispatcher");
  assert.equal(ci.location, "Joliet, IL");
  assert.equal(ci.note, "Driver reported a rest stop.");
  assert.equal(new Date(ci.observed_at).toISOString(), data.observed_at);
  assert(new Date(ci.recorded_at) > new Date(ci.observed_at));
  assert.equal(ci.idempotency_key, undefined);
  assert.equal(ci.request_hash, undefined);
  const events = await pool.query(
    "SELECT * FROM load_events WHERE load_id=$1 AND type='load.check-in'",
    [l.id],
  );
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].actor_id, dispatcher);
  assert.equal(events.rows[0].carrier_id, carrier);
  assert.equal(events.rows[0].payload.check_in_id, ci.id);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM outbox_events WHERE event_id=$1", [
        events.rows[0].id,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE resource_id=$1 AND action='load.check-in'",
        [l.id],
      )
    ).rowCount,
    1,
  );
  await assert.rejects(
    pool.query("UPDATE check_ins SET location='Changed' WHERE id=$1", [ci.id]),
    /Append-only/,
  );
  await assert.rejects(
    pool.query("DELETE FROM check_ins WHERE id=$1", [ci.id]),
    /Append-only/,
  );
});

test("check-ins enforce carrier scope and assigned-driver permissions", async () => {
  const mine = await load();
  const foreign = await load(foreignCarrier);
  await assert.rejects(
    recordCheckIn(manager, foreign.id, observation()),
    /NOT_FOUND/,
  );
  await assert.rejects(
    recordCheckIn(driverUser, mine.id, observation()),
    /NOT_FOUND/,
  );
  await mutate(dispatcher, mine.id, "assign", { version: 1, driverId: driver });
  await assert.rejects(
    recordCheckIn(otherDriverUser, mine.id, observation(2)),
    /NOT_FOUND/,
  );
  await assert.rejects(
    recordCheckIn(driverUser, foreign.id, observation()),
    /NOT_FOUND/,
  );
  await recordCheckIn(driverUser, mine.id, observation(2));
  await recordCheckIn(manager, mine.id, observation(3));
  const d = await detail(driverUser, mine.id);
  assert.equal(d.check_ins.length, 2);
  assert.equal(d.version, 4);
  assert.equal(d.stage, "booked");
  assert.equal((await detail(dispatcher, foreign.id)).version, 1);
});

test("concurrent retries are idempotent after later milestones; changed payloads conflict", async () => {
  const l = await load();
  await mutate(dispatcher, l.id, "assign", { version: 1, driverId: driver });
  const data = observation(2);
  const [first, retry] = await Promise.all([
    recordCheckIn(dispatcher, l.id, {
      ...data,
      idempotency_key: data.idempotency_key.toUpperCase(),
    }),
    recordCheckIn(dispatcher, l.id, data),
  ]);
  assert.deepEqual(first, retry);
  const [concurrentRetry] = await Promise.all([
    recordCheckIn(dispatcher, l.id, data),
    mutate(dispatcher, l.id, "milestones", { version: 3, stage: "dispatched" }),
  ]);
  assert.deepEqual(concurrentRetry, first);
  assert.deepEqual(await recordCheckIn(dispatcher, l.id, data), first);
  await assert.rejects(
    recordCheckIn(dispatcher, l.id, { ...data, note: "Changed report" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const another = await load();
  await assert.rejects(
    recordCheckIn(dispatcher, another.id, data),
    /IDEMPOTENCY_CONFLICT/,
  );
  const d = await detail(dispatcher, l.id);
  assert.equal(d.check_ins.length, 1);
  assert.equal(d.version, 4);
  assert.equal(d.stage, "dispatched");
  assert.equal(
    d.events.filter((e: { type: string }) => e.type === "load.check-in").length,
    1,
  );
});

test("a reassigned driver cannot replay an earlier successful check-in", async () => {
  const l = await load();
  await mutate(dispatcher, l.id, "assign", { version: 1, driverId: driver });
  const data = observation(2);
  await recordCheckIn(driverUser, l.id, data);
  await mutate(dispatcher, l.id, "assign", {
    version: 3,
    driverId: otherDriver,
  });
  await assert.rejects(recordCheckIn(driverUser, l.id, data), /NOT_FOUND/);
  assert.equal((await detail(dispatcher, l.id)).version, 4);
});

test("concurrent different observations cannot lose a version or duplicate history", async () => {
  const l = await load();
  const outcomes = await Promise.allSettled([
    recordCheckIn(dispatcher, l.id, observation()),
    recordCheckIn(manager, l.id, observation()),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter(
      (o) => o.status === "rejected" && o.reason.message === "VERSION_CONFLICT",
    ).length,
    1,
  );
  const d = await detail(dispatcher, l.id);
  assert.equal(d.version, 2);
  assert.equal(d.check_ins.length, 1);
  assert.equal(
    d.events.filter((e: { type: string }) => e.type === "load.check-in").length,
    1,
  );
});

test("invalid check-in time and spoofed provenance leave no records or version changes", async () => {
  const l = await load();
  for (const observed_at of [
    new Date(Date.now() + 10 * 60_000).toISOString(),
    new Date(Date.now() - 31 * 86_400_000).toISOString(),
  ])
    await assert.rejects(
      recordCheckIn(dispatcher, l.id, { ...observation(), observed_at }),
      /CHECK_IN_TIME_OUT_OF_RANGE/,
    );
  for (const patch of [
    { location: " " },
    { location: "a".repeat(161) },
    { note: "a".repeat(1001) },
    { observed_at: "2026-02-30T12:00:00Z" },
    { observed_at: "2026-01-01T12:00:00" },
    { version: 1.5 },
    { idempotency_key: "not-a-uuid" },
    { source: "gps" },
    { actor_id: manager },
  ]) {
    assert.equal(
      checkInSchema.safeParse({ ...observation(), ...patch }).success,
      false,
    );
    await assert.rejects(
      recordCheckIn(dispatcher, l.id, { ...observation(), ...patch }),
      (error: unknown) => error instanceof Error && error.name === "ZodError",
    );
  }
  const d = await detail(dispatcher, l.id);
  assert.equal(d.version, 1);
  assert.equal(d.check_ins.length, 0);
  assert.equal(d.events.length, 1);
});

test("late reports sort by observation time and detail history is bounded", async () => {
  const l = await load();
  const base = Date.now() - 86_400_000;
  for (let i = 0; i < 102; i++)
    await recordCheckIn(dispatcher, l.id, {
      ...observation(i + 1),
      observed_at: new Date(base + (101 - i) * 60_000).toISOString(),
      location: "Report " + (101 - i),
    });
  const d = await detail(dispatcher, l.id);
  assert.equal(d.check_ins.length, 50);
  assert.equal(d.check_ins[0].location, "Report 101");
  assert.equal(d.check_ins[49].location, "Report 52");
  assert.equal(d.version, 103);
  assert.equal(d.events.length, 100);
  assert.equal(d.events_truncated, true);
  assert.equal(d.events.at(-1)?.payload.location, "Report 0");
  assert.equal(
    (await pool.query("SELECT 1 FROM load_events WHERE load_id=$1", [l.id]))
      .rowCount,
    103,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM check_ins WHERE load_id=$1", [l.id]))
      .rowCount,
    102,
  );
});

test("check-in API authenticates, audits denied carrier access and returns structured errors", async () => {
  const mine = await load();
  const foreign = await load(foreignCarrier);
  const token = randomUUID();
  await pool.query(
    "INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')",
    [digest(token), manager],
  );
  const origin = process.env.APP_ORIGIN || "http://localhost:3000";
  function request(id: string, data: unknown, cookie = true) {
    return new NextRequest(origin + "/api/loads/" + id + "/check-ins", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie: "relay_session=" + token } : {}),
      },
      body: JSON.stringify(data),
    });
  }
  const unauthenticated = await POST(request(mine.id, observation(), false));
  assert.equal(unauthenticated.status, 401);
  const denied = await POST(request(foreign.id, observation()));
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "NOT_FOUND" });
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE actor_id=$1 AND action='access.denied' AND resource_id=$2",
        [manager, "/api/loads/" + foreign.id + "/check-ins"],
      )
    ).rowCount,
    1,
  );
  const invalid = await POST(
    request(mine.id, { ...observation(), source: "gps" }),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "VALIDATION_ERROR");
  const accepted = await POST(request(mine.id, observation()));
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store");
  const result = await accepted.json();
  assert.equal(result.id, mine.id);
  assert.equal(result.version, 2);
  const conflict = await POST(request(mine.id, observation()));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "VERSION_CONFLICT" });
  await pool.query("DELETE FROM sessions WHERE token_hash=$1", [digest(token)]);
});
