import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { detail, mutate } from "../../src/lib/loads";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Fleet");
});
after(() => pool.end());

const call = async (
  method: "GET" | "POST",
  path: string,
  user?: string,
  json?: unknown,
) => {
  const req = request(path, {
    method,
    ...(user ? { token: await sessionFor(user) } : {}),
    ...(json ? { json } : {}),
  });
  const res = await (method === "GET" ? GET(req) : POST(req));
  return { status: res.status, body: await res.json() };
};
const make = (over: Record<string, unknown> = {}, user = t.dispatcher) =>
  call("POST", "fleet/vehicles", user, {
    carrier_id: t.carrier,
    label: "Unit " + randomUUID().slice(0, 6),
    kind: "tractor",
    plate: "",
    vin: "",
    key: randomUUID(),
    ...over,
  });
const overview = async (user = t.dispatcher, carrier = t.carrier) =>
  call("GET", "fleet?carrier_id=" + carrier, user);

test("dispatchers and carrier managers can read and change a carrier's fleet; nobody else can", async () => {
  assert.equal((await overview()).status, 200);
  assert.equal((await overview(t.manager)).status, 200);
  const vehicle = (await make()).body;
  const guesses: [string, "GET" | "POST", string, unknown?][] = [
    ["list", "GET", "fleet?carrier_id=" + t.carrier],
    [
      "create",
      "POST",
      "fleet/vehicles",
      {
        carrier_id: t.carrier,
        label: "x",
        kind: "tractor",
        plate: "",
        vin: "",
        key: randomUUID(),
      },
    ],
    [
      "update",
      "POST",
      "fleet/vehicles/" + vehicle.id,
      {
        label: "x",
        kind: "tractor",
        plate: "",
        vin: "",
        version: 1,
        key: randomUUID(),
      },
    ],
    [
      "status",
      "POST",
      "fleet/vehicles/" + vehicle.id + "/status",
      { status: "retired", version: 1, key: randomUUID() },
    ],
  ];
  for (const user of [t.driverUser, t.foreignManager, t.otherDriverUser]) {
    for (const [name, method, path, json] of guesses) {
      const r = await call(method, path, user, json);
      assert.equal(r.status, 404, name);
      assert.deepEqual(r.body, { error: "NOT_FOUND" }, name);
    }
  }
  const anon = await call("GET", "fleet?carrier_id=" + t.carrier);
  assert.equal(anon.status, 401);
  // The vehicle was not touched by any of those.
  const v = (await overview()).body.vehicles.find(
    (x: { id: string }) => x.id === vehicle.id,
  );
  assert.equal(v.version, 1);
  assert.equal(v.status, "active");
});

test("a vehicle needs a label and a valid kind; the VIN is checked; plate and VIN are upper-cased", async () => {
  for (const bad of [
    { label: "" },
    { label: "   " },
    { label: "x".repeat(61) },
    { kind: "spaceship" },
    { vin: "ABC123" },
    { vin: "1HGCM82633AO04352" }, // has an O
    { plate: "x".repeat(21) },
    { extra: "field" },
    { key: "not-a-uuid" },
  ])
    assert.equal((await make(bad)).status, 400, JSON.stringify(bad));
  const ok = await make({
    label: "  Unit 7  ",
    plate: " ab-123 ",
    vin: "1hgcm82633a004352",
  });
  assert.equal(ok.status, 201);
  const v = (await overview()).body.vehicles.find(
    (x: { id: string }) => x.id === ok.body.id,
  );
  assert.deepEqual(
    [v.label, v.plate, v.vin, v.kind, v.status, v.version],
    ["Unit 7", "AB-123", "1HGCM82633A004352", "tractor", "active", 1],
  );
});

test("a label is unique within a carrier, ignoring case, and free in another carrier", async () => {
  const label = "Dup " + randomUUID().slice(0, 5);
  assert.equal((await make({ label })).status, 201);
  const again = await make({ label: label.toUpperCase() });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { error: "DUPLICATE_VEHICLE" });
  const other = await call("POST", "fleet/vehicles", t.foreignManager, {
    carrier_id: t.foreign,
    label,
    kind: "tractor",
    plate: "",
    vin: "",
    key: randomUUID(),
  });
  assert.equal(other.status, 201);
});

test("a repeated create with the same key is one vehicle; the same key with other data is refused", async () => {
  const key = randomUUID();
  const label = "Idem " + randomUUID().slice(0, 5);
  const first = await make({ label, key });
  const second = await make({ label, key });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  const count = await pool.query(
    "SELECT count(*)::int n FROM vehicles WHERE carrier_id=$1 AND label=$2",
    [t.carrier, label],
  );
  assert.equal(count.rows[0].n, 1);
  const conflict = await make({ label: label + " b", key });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { error: "IDEMPOTENCY_CONFLICT" });
});

test("updates use the version; a stale edit is a conflict, not an overwrite", async () => {
  const v = (await make({ label: "Edit " + randomUUID().slice(0, 5) })).body;
  const body = (version: number, over = {}) => ({
    label: "Edited " + randomUUID().slice(0, 5),
    kind: "cargo_van",
    plate: "ZZ 1",
    vin: "",
    version,
    key: randomUUID(),
    ...over,
  });
  const first = await call(
    "POST",
    "fleet/vehicles/" + v.id,
    t.dispatcher,
    body(1),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 2);
  const stale = await call(
    "POST",
    "fleet/vehicles/" + v.id,
    t.manager,
    body(1),
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: "VERSION_CONFLICT" });
  const taken = (await make({ label: "Taken " + randomUUID().slice(0, 5) }))
    .body;
  const dupe = await call(
    "POST",
    "fleet/vehicles/" + v.id,
    t.dispatcher,
    body(2, {
      label: (
        await pool.query("SELECT label FROM vehicles WHERE id=$1", [taken.id])
      ).rows[0].label,
    }),
  );
  assert.equal(dupe.status, 409);
  assert.deepEqual(dupe.body, { error: "DUPLICATE_VEHICLE" });
});

test("retiring and reactivating a vehicle", async () => {
  const v = (await make()).body;
  const retire = await call(
    "POST",
    `fleet/vehicles/${v.id}/status`,
    t.manager,
    { status: "retired", version: 1, key: randomUUID() },
  );
  assert.equal(retire.status, 200);
  const stale = await call("POST", `fleet/vehicles/${v.id}/status`, t.manager, {
    status: "active",
    version: 1,
    key: randomUUID(),
  });
  assert.equal(stale.status, 409);
  const back = await call("POST", `fleet/vehicles/${v.id}/status`, t.manager, {
    status: "active",
    version: 2,
    key: randomUUID(),
  });
  assert.equal(back.status, 200);
  const row = (await overview()).body.vehicles.find(
    (x: { id: string }) => x.id === v.id,
  );
  assert.deepEqual([row.status, row.version], ["active", 3]);
});

test("the overview lists drivers (not removed ones) and counts active loads for drivers and vehicles", async () => {
  const removed = randomUUID();
  await pool.query(
    "INSERT INTO drivers(id,carrier_id,name,onboarding_status) VALUES($1,$2,'Gone Driver','removed')",
    [removed, t.carrier],
  );
  const v = (await make()).body;
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.driver,
    vehicleId: v.id,
  });
  const o = (await overview()).body;
  assert.ok(!o.drivers.some((d: { id: string }) => d.id === removed));
  assert.equal(
    o.drivers.find((d: { id: string }) => d.id === t.driver).active_loads,
    1,
  );
  assert.equal(
    o.vehicles.find((x: { id: string }) => x.id === v.id).active_loads,
    1,
  );
  assert.deepEqual(Object.keys(o.drivers[0]).sort(), [
    "active_loads",
    "email",
    "id",
    "name",
    "phone",
    "status",
  ]);
  // Delivered loads stop counting.
  await pool.query("UPDATE loads SET stage='delivered' WHERE id=$1", [load.id]);
  const after = (await overview()).body;
  assert.equal(
    after.vehicles.find((x: { id: string }) => x.id === v.id).active_loads,
    0,
  );
});

test("assignment: only this carrier's vehicles in service; reassigning keeps or clears the vehicle", async () => {
  const mine = (await make({ label: "Assign " + randomUUID().slice(0, 5) }))
    .body;
  const foreign = (
    await call("POST", "fleet/vehicles", t.foreignManager, {
      carrier_id: t.foreign,
      label: "Foreign " + randomUUID().slice(0, 5),
      kind: "tractor",
      plate: "",
      vin: "",
      key: randomUUID(),
    })
  ).body;
  const retired = (await make({ label: "Retired " + randomUUID().slice(0, 5) }))
    .body;
  await call("POST", `fleet/vehicles/${retired.id}/status`, t.dispatcher, {
    status: "retired",
    version: 1,
    key: randomUUID(),
  });
  const load = await bookedLoad(t.dispatcher, t.carrier);
  let version = load.version;
  for (const [vehicleId, why] of [
    [foreign.id, "another carrier's vehicle"],
    [retired.id, "a retired vehicle"],
    [randomUUID(), "an unknown vehicle"],
  ] as const)
    await assert.rejects(
      mutate(t.dispatcher, load.id, "assign", {
        version,
        driverId: t.driver,
        vehicleId,
      }),
      (e: { status?: number; message?: string }) =>
        e.status === 422 || /VEHICLE_CARRIER_MISMATCH/.test(String(e.message)),
      why,
    );
  version = (
    await mutate(t.dispatcher, load.id, "assign", {
      version,
      driverId: t.driver,
      vehicleId: mine.id,
    })
  ).version;
  let d = await detail(t.dispatcher, load.id);
  assert.equal(d.assignment?.vehicle_id, mine.id);
  assert.match(String(d.assignment?.vehicle_label), /^Assign /);
  // Reassigning the driver without naming a vehicle keeps it.
  version = (
    await mutate(t.dispatcher, load.id, "assign", {
      version,
      driverId: t.otherDriver,
    })
  ).version;
  d = await detail(t.dispatcher, load.id);
  assert.equal(d.assignment?.driver_id, t.otherDriver);
  assert.equal(d.assignment?.vehicle_id, mine.id);
  // Retiring it later does not remove it from the load.
  const row = (await overview()).body.vehicles.find(
    (x: { id: string }) => x.id === mine.id,
  );
  await call("POST", `fleet/vehicles/${mine.id}/status`, t.dispatcher, {
    status: "retired",
    version: row.version,
    key: randomUUID(),
  });
  assert.equal(
    (await detail(t.dispatcher, load.id)).assignment?.vehicle_id,
    mine.id,
  );
  // null clears it.
  await mutate(t.dispatcher, load.id, "assign", {
    version,
    driverId: t.otherDriver,
    vehicleId: null,
  });
  assert.equal(
    (await detail(t.dispatcher, load.id)).assignment?.vehicle_id,
    null,
  );
});

test("every change is recorded for audit", async () => {
  const label = "Audited " + randomUUID().slice(0, 5);
  const v = (await make({ label })).body;
  await call("POST", `fleet/vehicles/${v.id}/status`, t.dispatcher, {
    status: "retired",
    version: 1,
    key: randomUUID(),
  });
  const events = await pool.query(
    "SELECT type FROM onboarding_events WHERE carrier_id=$1 AND payload->>'vehicle_id'=$2 ORDER BY created_at",
    [t.carrier, v.id],
  );
  assert.deepEqual(
    events.rows.map((r) => r.type),
    ["vehicle.created", "vehicle.retired"],
  );
  const audit = await pool.query(
    "SELECT action,organization_id FROM audit_logs WHERE actor_id=$1 AND resource_id=$2 AND action LIKE 'vehicle.%' ORDER BY created_at",
    [t.dispatcher, t.carrier],
  );
  assert.ok(audit.rows.some((r) => r.action === "vehicle.created"));
  assert.ok(audit.rows.every((r) => r.organization_id === t.organization));
});
