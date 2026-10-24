import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  archiveContact,
  createContact,
  directory,
  setFavorite,
  updateContact,
} from "../../src/lib/contacts";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Contacts");
  await pool.query("UPDATE users SET phone='(312) 555-0142' WHERE id=$1", [
    t.dispatcher,
  ]);
  await pool.query("UPDATE users SET phone='773-555-0188' WHERE id=$1", [
    t.manager,
  ]);
  await pool.query("UPDATE drivers SET phone='615 555 0111' WHERE id=$1", [
    t.driver,
  ]);
  await pool.query(
    "INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone) VALUES($1,'Casey Carrier','casey@carrier.test','800-555-0100')",
    [t.carrier],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
});
after(() => pool.end());

const find = (q: string) => new URLSearchParams({ q });
const names = async (user: string, params = new URLSearchParams()) =>
  (await directory(user, params)).entries.map((e) => e.name).sort();
const fields = (over: Record<string, unknown> = {}) => {
  const { idempotency_key, ...rest } = contact(over);
  void idempotency_key;
  return rest;
};
const contact = (over: Record<string, unknown> = {}) => ({
  idempotency_key: randomUUID(),
  kind: "broker",
  name: "Morgan Broker",
  company: "Fictional Freight Brokers",
  email: "Morgan@Broker.TEST",
  phone: "(214) 555-0199",
  notes: "Prefers email before 9am",
  carrier_id: null,
  ...over,
});

test("each role sees only the people it should", async () => {
  const dispatcherView = await directory(t.dispatcher, new URLSearchParams());
  const groups = (g: string) =>
    dispatcherView.entries.filter((e) => e.group === g);
  // A dispatcher sees managers, drivers and carriers, never themselves.
  assert.ok(groups("team").some((e) => e.key === "user:" + t.manager));
  assert.ok(
    !dispatcherView.entries.some((e) => e.key === "user:" + t.dispatcher),
  );
  assert.equal(groups("driver").length, 2);
  assert.ok(groups("carrier").some((e) => e.name.includes("Contacts carrier")));
  // A carrier manager sees their dispatcher and their drivers, not other carriers' people.
  const manager = await directory(t.manager, new URLSearchParams());
  assert.ok(manager.entries.some((e) => e.key === "user:" + t.dispatcher));
  assert.equal(manager.entries.filter((e) => e.group === "driver").length, 2);
  assert.ok(!manager.entries.some((e) => e.key === "user:" + t.foreignManager));
  assert.equal(manager.entries.filter((e) => e.group === "carrier").length, 0);
  // A driver reaches dispatch and the carrier manager only.
  const driver = await directory(t.driverUser, new URLSearchParams());
  assert.deepEqual(
    driver.entries.map((e) => [e.group, e.key]).sort(),
    [
      ["team", "user:" + t.dispatcher],
      ["team", "user:" + t.manager],
    ].sort(),
  );
  assert.equal(driver.can_add, false);
  // The other carrier's manager sees nothing of this tenant.
  const foreign = await directory(t.foreignManager, new URLSearchParams());
  assert.ok(
    foreign.entries.every((e) => e.carriers.every((c) => c.id !== t.carrier)),
  );
});

test("search matches name, company, email and phone digits, and filters by carrier and group", async () => {
  await createContact(t.dispatcher, contact());
  assert.deepEqual(await names(t.dispatcher, find("morgan")), [
    "Morgan Broker",
  ]);
  assert.deepEqual(await names(t.dispatcher, find("fictional freight")), [
    "Morgan Broker",
  ]);
  assert.deepEqual(await names(t.dispatcher, find("broker.test")), [
    "Morgan Broker",
  ]);
  // Phone numbers match however they were typed.
  assert.deepEqual(await names(t.dispatcher, find("214-555")), [
    "Morgan Broker",
  ]);
  assert.deepEqual(await names(t.dispatcher, find("2145550199")), [
    "Morgan Broker",
  ]);
  // Teammates' phones are searchable too (the caller never finds themselves).
  assert.deepEqual(await names(t.manager, find("555 0142")), [
    "Contacts Dispatcher",
  ]);
  assert.deepEqual(await names(t.dispatcher, find("555 0142")), []);
  assert.deepEqual(await names(t.dispatcher, find("zzz-no-match")), []);
  const external = await directory(
    t.dispatcher,
    new URLSearchParams({ group: "external" }),
  );
  assert.ok(external.entries.every((e) => e.group === "external"));
  const drivers = await directory(
    t.dispatcher,
    new URLSearchParams({ group: "driver", carrier_id: t.carrier }),
  );
  assert.equal(drivers.entries.length, 2);
  assert.equal(
    (await directory(t.dispatcher, new URLSearchParams({ q: "%_" }))).entries
      .length,
    0,
  );
  await assert.rejects(
    directory(t.dispatcher, new URLSearchParams({ group: "bogus" })),
    {
      name: "ZodError",
    },
  );
});

test("external contacts are organization-wide for dispatchers and carrier-scoped for managers", async () => {
  const orgWide = await createContact(
    t.dispatcher,
    contact({ name: "Org Wide Shipper", kind: "shipper" }),
  );
  const linked = await createContact(
    t.dispatcher,
    contact({
      name: "Linked Receiver",
      kind: "receiver",
      carrier_id: t.carrier,
    }),
  );
  await createContact(
    t.dispatcher,
    contact({
      name: "Foreign Linked",
      kind: "receiver",
      carrier_id: t.foreign,
    }),
  );
  const managerNames = await names(
    t.manager,
    new URLSearchParams({ group: "external" }),
  );
  assert.ok(managerNames.includes("Linked Receiver"));
  assert.ok(!managerNames.includes("Org Wide Shipper"));
  assert.ok(!managerNames.includes("Foreign Linked"));
  // Drivers and outsiders see no external contacts.
  assert.equal(
    (await directory(t.driverUser, new URLSearchParams({ group: "external" })))
      .entries.length,
    0,
  );
  assert.ok(
    !(
      await names(t.foreignManager, new URLSearchParams({ group: "external" }))
    ).includes("Org Wide Shipper"),
  );
  // Managers may add contacts only for their own carrier; drivers never.
  await createContact(
    t.manager,
    contact({ name: "Manager Added", carrier_id: t.carrier }),
  );
  await assert.rejects(
    createContact(t.manager, contact({ carrier_id: t.foreign })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    createContact(t.manager, contact({ carrier_id: null })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    createContact(t.driverUser, contact({ carrier_id: t.carrier })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    createContact(t.foreignManager, contact({ carrier_id: t.carrier })),
    { code: "NOT_FOUND" },
  );
  // Editing follows the same scope, with optimistic versions.
  await assert.rejects(
    updateContact(t.manager, orgWide.id, { ...fields(), version: 1 }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    updateContact(t.foreignManager, linked.id, { ...fields(), version: 1 }),
    { code: "NOT_FOUND" },
  );
  const edited = await updateContact(t.manager, linked.id, {
    ...fields({
      name: "Linked Receiver",
      kind: "receiver",
      carrier_id: t.carrier,
      phone: "999-555-0100",
    }),
    version: 1,
    change_reason: "Receiver moved offices",
  });
  assert.equal(edited.version, 2);
  // The new number waits for a second person (ADR 0064); the rest applied now.
  assert.equal(
    (edited as { pending_approval?: boolean }).pending_approval,
    true,
  );
  await assert.rejects(
    updateContact(t.manager, linked.id, {
      ...fields({ carrier_id: t.carrier }),
      version: 1,
    }),
    {
      code: "VERSION_CONFLICT",
    },
  );
  // A manager cannot move a contact to a carrier they do not manage.
  await assert.rejects(
    updateContact(t.manager, linked.id, {
      ...fields({ carrier_id: t.foreign }),
      version: 2,
    }),
    { code: "NOT_FOUND" },
  );
  await archiveContact(t.dispatcher, orgWide.id, { version: 1 });
  assert.ok(!(await names(t.dispatcher)).includes("Org Wide Shipper"));
});

test("validation and idempotent creation", async () => {
  const input = contact({ name: "Retry Contact" });
  const first = await createContact(t.dispatcher, input);
  assert.deepEqual(await createContact(t.dispatcher, input), first);
  await assert.rejects(createContact(t.dispatcher, { ...input, phone: "1" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  await assert.rejects(
    createContact(t.dispatcher, contact({ email: "", phone: "" })),
    { name: "ZodError" },
  );
  await assert.rejects(
    createContact(t.dispatcher, contact({ email: "not-an-email" })),
    { name: "ZodError" },
  );
  await assert.rejects(
    createContact(t.dispatcher, contact({ kind: "wizard" })),
    { name: "ZodError" },
  );
  const stored = await pool.query("SELECT email FROM contacts WHERE id=$1", [
    first.id,
  ]);
  assert.equal(stored.rows[0].email, "morgan@broker.test");
});

test("favorites are per user, only for visible entries, and sort first", async () => {
  await setFavorite(t.dispatcher, { key: "user:" + t.manager, favorite: true });
  await setFavorite(t.dispatcher, { key: "user:" + t.manager, favorite: true });
  const entries = (await directory(t.dispatcher, new URLSearchParams()))
    .entries;
  assert.equal(entries[0].key, "user:" + t.manager);
  assert.equal(entries[0].favorite, true);
  assert.equal(
    (await directory(t.dispatcher, new URLSearchParams({ favorites: "true" })))
      .entries.length,
    1,
  );
  // Another user's favorite is not shared.
  assert.ok(
    (await directory(t.manager, new URLSearchParams())).entries.every(
      (e) => !e.favorite,
    ),
  );
  // A driver cannot star another driver's record, nor anything foreign.
  await assert.rejects(
    setFavorite(t.driverUser, {
      key: "driver:" + t.otherDriver,
      favorite: true,
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    setFavorite(t.foreignManager, { key: "user:" + t.manager, favorite: true }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    setFavorite(t.dispatcher, { key: "user:not-a-uuid", favorite: true }),
    { name: "ZodError" },
  );
  await setFavorite(t.dispatcher, {
    key: "user:" + t.manager,
    favorite: false,
  });
  assert.equal(
    (await directory(t.dispatcher, new URLSearchParams({ favorites: "true" })))
      .entries.length,
    0,
  );
});

test("HTTP: authenticated, origin-checked and no-store", async () => {
  assert.equal((await GET(request("contacts"))).status, 401);
  const token = await sessionFor(t.manager);
  const response = await GET(request("contacts?q=morgan", { token }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const forged = await POST(
    request("contacts", {
      token,
      json: contact({ carrier_id: t.carrier }),
      headers: { origin: "https://untrusted.example" },
    }),
  );
  assert.equal(forged.status, 403);
});

test("a large roster never hides a whole category", async () => {
  const big = await tenant("BigRoster");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [big.organization, big.dispatcher],
  );
  for (let i = 0; i < 30; i++)
    await pool.query(
      "INSERT INTO drivers(id,carrier_id,name) VALUES($1,$2,$3)",
      [
        randomUUID(),
        big.carrier,
        "Roster Driver " + String(i).padStart(2, "0"),
      ],
    );
  await createContact(big.dispatcher, contact({ name: "Last Sorted Broker" }));
  const all = await directory(big.dispatcher, new URLSearchParams());
  assert.equal(all.entries.filter((e) => e.group === "driver").length, 25);
  assert.ok(all.entries.some((e) => e.name === "Last Sorted Broker"));
  assert.equal(all.more?.driver, 32);
  assert.equal(all.truncated, true);
  const drivers = await directory(
    big.dispatcher,
    new URLSearchParams({ group: "driver" }),
  );
  assert.equal(drivers.entries.length, 32);
  assert.equal(drivers.truncated, false);
});
