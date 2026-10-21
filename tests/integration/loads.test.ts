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
import {
  login,
  verifyPassword,
  hashPassword,
  consumeLoginAttempt,
  digest,
} from "../../src/lib/auth";
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
  assert(await verifyPassword("a secure fictional password", hash));
  assert(!(await verifyPassword("wrong", hash)));
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

test("expired dispatch authorization prevents assignment without changing the load", async () => {
  const org = (await pool.query("SELECT id FROM organizations LIMIT 1")).rows[0]
    .id;
  const carrier = randomUUID(),
    driver = randomUUID(),
    authorization = randomUUID();
  await pool.query("INSERT INTO carriers VALUES($1,$2,$3)", [
    carrier,
    org,
    "Expired agreement QA",
  ]);
  await pool.query("INSERT INTO drivers VALUES($1,$2,$3)", [
    driver,
    carrier,
    "Expired agreement driver",
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,$3,NULL)", [
    dispatcher,
    carrier,
    "dispatcher",
  ]);
  await pool.query(
    "INSERT INTO carrier_dispatch_authorizations VALUES($1,$2,'QA',now(),now()-interval '2 days',now()+interval '1 day')",
    [authorization, carrier],
  );
  const load = await createLoad(dispatcher, input(carrier), randomUUID());
  await pool.query(
    "UPDATE carrier_dispatch_authorizations SET expires_at=now()-interval '1 day' WHERE id=$1",
    [authorization],
  );
  await assert.rejects(
    mutate(dispatcher, load.id, "assign", { version: 1, driverId: driver }),
    /CARRIER_AUTHORIZATION_REQUIRED/,
  );
  assert.equal((await detail(dispatcher, load.id)).version, 1);
});

test("foreign-carrier detail requests do not wait for a lock on another tenant", async () => {
  const load = await createLoad(dispatcher, input(carrierB), randomUUID());
  const locker = await pool.connect();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM loads WHERE id=$1 FOR UPDATE", [
      load.id,
    ]);
    const denied = detail(manager, load.id).then(
      () => false,
      (e) => e.message === "NOT_FOUND",
    );
    const result = await Promise.race([
      denied,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    assert.equal(
      result,
      true,
      "Authorization should reject without locking a foreign load",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    await locker.query("ROLLBACK");
    locker.release();
  }
});

test("login throttling is atomic and shared by independent connections", async () => {
  const email = "rate-" + randomUUID() + "@relay.test";
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => consumeLoginAttempt(email)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 8);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.message === "TRY_AGAIN_LATER",
    ).length,
    4,
  );
  const row = await pool.query(
    "SELECT attempts FROM login_attempts WHERE identity_hash=$1",
    [digest(email)],
  );
  assert.equal(row.rows[0].attempts, 12);
});

test("queue cursor does not duplicate records when a new load arrives", async () => {
  const carrier = randomUUID();
  const org = (await pool.query("SELECT id FROM organizations LIMIT 1")).rows[0]
    .id;
  await pool.query("INSERT INTO carriers VALUES($1,$2,$3)", [
    carrier,
    org,
    "Pagination QA",
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,$3,NULL)", [
    dispatcher,
    carrier,
    "dispatcher",
  ]);
  await pool.query(
    "INSERT INTO carrier_dispatch_authorizations VALUES($1,$2,'QA',now(),now()-interval '1 day',now()+interval '1 year')",
    [randomUUID(), carrier],
  );
  for (let i = 0; i < 26; i++)
    await createLoad(dispatcher, input(carrier), randomUUID());
  const first = await listLoads(
    dispatcher,
    new URLSearchParams({ carrier_id: carrier }),
  );
  assert.equal(first.loads.length, 25);
  assert(first.nextCursor);
  await createLoad(dispatcher, input(carrier), randomUUID());
  const second = await listLoads(
    dispatcher,
    new URLSearchParams({ carrier_id: carrier, cursor: first.nextCursor }),
  );
  assert.equal(second.loads.length, 1);
  assert(second.loads.every((b) => !first.loads.some((a) => a.id === b.id)));
  await assert.rejects(
    listLoads(dispatcher, new URLSearchParams({ cursor: "malformed" })),
    /INVALID_CURSOR/,
  );
});

test("malformed stop counts produce validation errors without throwing", () => {
  const data = input(carrierA);
  for (const stops of [[], [data.stops[0]], [...data.stops, data.stops[1]]]) {
    const result = createSchema.safeParse({ ...data, stops });
    assert.equal(result.success, false);
  }
});

test("opaque cursor dates reject impossible calendar and timezone values", async () => {
  for (const at of [
    "2026-02-30 10:00:00+00",
    "2026-13-01 10:00:00+00",
    "0000-01-01 10:00:00+00",
    "2026-01-01 24:00:00+00",
    "2026-01-01 10:00:00+24",
  ]) {
    const cursor = Buffer.from(
      JSON.stringify({ at, id: randomUUID() }),
    ).toString("base64url");
    await assert.rejects(
      listLoads(dispatcher, new URLSearchParams({ cursor })),
      (error: unknown) =>
        error instanceof Error && error.message === "INVALID_CURSOR",
    );
  }
});

test("duplicate query fields cannot bypass validation of the field actually queried", async () => {
  const params = new URLSearchParams();
  params.append("q", "x".repeat(101));
  params.append("q", "valid");
  await assert.rejects(
    listLoads(dispatcher, params),
    (error: unknown) => error instanceof Error && error.name === "ZodError",
  );
});
