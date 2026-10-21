import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import {
  createLoad,
  listLoads,
  detail,
  mutate,
  createSchema,
} from "../../src/lib/loads";
import { login, verifyPassword, hashPassword } from "../../src/lib/auth";
let dispatcher: string,
  manager: string,
  driverUser: string,
  carrierA: string,
  carrierB: string,
  driverA: string,
  driverB: string;
before(async () => {
  const users = await pool.query("SELECT id,email FROM users");
  dispatcher = users.rows.find((u) => u.email === "dispatcher@relay.test").id;
  manager = users.rows.find((u) => u.email === "carrier@relay.test").id;
  driverUser = users.rows.find((u) => u.email === "driver@relay.test").id;
  const c = await pool.query("SELECT id,name FROM carriers");
  carrierA = c.rows.find((c) => c.name === "Blue Ridge Transport").id;
  carrierB = c.rows.find((c) => c.name === "Prairie Line Logistics").id;
  const d = await pool.query("SELECT id,carrier_id FROM drivers");
  driverA = d.rows.find((d) => d.carrier_id === carrierA).id;
  driverB = d.rows.find((d) => d.carrier_id === carrierB).id;
});
after(() => pool.end());
function input(carrierId: string) {
  return {
    carrierId,
    reference: "TEST-" + randomUUID(),
    source: "Fictional test",
    amountMinor: 250001,
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
  };
}
test("password verification and authenticated session creation", async () => {
  const hash = hashPassword("a secure fictional password");
  assert(verifyPassword("a secure fictional password", hash));
  assert(!verifyPassword("wrong", hash));
  assert(
    (await login("dispatcher@relay.test", process.env.SEED_PASSWORD!))
      .length === 64,
  );
  await assert.rejects(
    login("dispatcher@relay.test", "incorrect"),
    /INVALID_CREDENTIALS/,
  );
});
test("idempotent concurrent creates, duplicate reference and request conflicts", async () => {
  const data = input(carrierA),
    key = randomUUID();
  const [a, b] = await Promise.all([
    createLoad(dispatcher, data, key),
    createLoad(dispatcher, data, key),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    createLoad(dispatcher, { ...data, amountMinor: 1 }, key),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    createLoad(dispatcher, data, randomUUID()),
    (e) => (e as { code: string }).code === "23505",
  );
  const events = await pool.query(
    "SELECT * FROM load_events WHERE load_id=$1",
    [a.id],
  );
  assert.equal(events.rowCount, 1);
  const outbox = await pool.query(
    "SELECT * FROM outbox_events WHERE event_id=$1",
    [events.rows[0].id],
  );
  assert.equal(outbox.rowCount, 1);
});
test("cross-carrier guessed IDs cannot be read or changed; driver writes denied", async () => {
  const load = await createLoad(dispatcher, input(carrierB), randomUUID());
  await assert.rejects(detail(manager, load.id), /NOT_FOUND/);
  await assert.rejects(
    mutate(manager, load.id, "assign", { version: 1, driverId: driverB }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    createLoad(manager, input(carrierB), randomUUID()),
    /NOT_FOUND/,
  );
  await assert.rejects(detail(driverUser, load.id), /NOT_FOUND/);
  const mine = await createLoad(dispatcher, input(carrierA), randomUUID());
  await assert.rejects(detail(driverUser, mine.id), /NOT_FOUND/);
  await mutate(dispatcher, mine.id, "assign", {
    version: 1,
    driverId: driverA,
  });
  assert.equal((await detail(driverUser, mine.id)).id, mine.id);
  await assert.rejects(
    mutate(driverUser, mine.id, "milestones", {
      version: 2,
      stage: "dispatched",
    }),
    /NOT_FOUND/,
  );
  assert(
    (await listLoads(manager, new URLSearchParams())).loads.every(
      (l) => l.carrier_id === carrierA,
    ),
  );
});
test("authorization dates required before booking", async () => {
  const id = randomUUID();
  const org = (await pool.query("SELECT id FROM organizations LIMIT 1")).rows[0]
    .id;
  await pool.query("INSERT INTO carriers VALUES($1,$2,$3)", [
    id,
    org,
    "Unauthorized QA",
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,$3,NULL)", [
    dispatcher,
    id,
    "dispatcher",
  ]);
  await assert.rejects(
    createLoad(dispatcher, input(id), randomUUID()),
    /CARRIER_AUTHORIZATION_REQUIRED/,
  );
});
test("assignment isolation, concurrency, valid milestones and durable append-only events", async () => {
  const load = await createLoad(dispatcher, input(carrierA), randomUUID());
  await assert.rejects(
    mutate(dispatcher, load.id, "assign", { version: 1, driverId: driverB }),
    /DRIVER_CARRIER_MISMATCH/,
  );
  await assert.rejects(
    mutate(dispatcher, load.id, "milestones", {
      version: 1,
      stage: "dispatched",
    }),
    /ASSIGN_DRIVER_FIRST/,
  );
  await mutate(dispatcher, load.id, "assign", {
    version: 1,
    driverId: driverA,
  });
  const results = await Promise.allSettled([
    mutate(dispatcher, load.id, "milestones", {
      version: 2,
      stage: "dispatched",
    }),
    mutate(dispatcher, load.id, "milestones", {
      version: 2,
      stage: "dispatched",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.message === "VERSION_CONFLICT",
    ).length,
    1,
  );
  await assert.rejects(
    mutate(dispatcher, load.id, "milestones", {
      version: 3,
      stage: "delivered",
    }),
    /INVALID_TRANSITION/,
  );
  await mutate(dispatcher, load.id, "milestones", {
    version: 3,
    stage: "picked-up",
  });
  await mutate(dispatcher, load.id, "milestones", {
    version: 4,
    stage: "delivered",
  });
  const d = await detail(dispatcher, load.id);
  assert.equal(d.stage, "delivered");
  assert.equal(d.events.length, 5);
  await assert.rejects(
    pool.query("DELETE FROM load_events WHERE load_id=$1", [load.id]),
    /Append-only/,
  );
});
test("stop ordering, timezone and integer money validation", () => {
  const data = input(carrierA);
  assert(!createSchema.safeParse({ ...data, amountMinor: 1.5 }).success);
  assert(
    !createSchema.safeParse({ ...data, stops: [data.stops[1], data.stops[0]] })
      .success,
  );
  assert(
    !createSchema.safeParse({
      ...data,
      stops: [{ ...data.stops[0], timezone: "Invalid/Zone" }, data.stops[1]],
    }).success,
  );
});
