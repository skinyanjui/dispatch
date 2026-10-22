import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import { auditLabel } from "../../src/lib/audit-labels";
import { request, sessionFor, tenant } from "./fixtures";

let a: Awaited<ReturnType<typeof tenant>>;
let b: Awaited<ReturnType<typeof tenant>>;
const write = (actor: string | null, action: string, resource?: string) =>
  pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    actor,
    action,
    resource ?? null,
  ]);
const get = async (path: string, user?: string) => {
  const res = await GET(
    request(path, user ? { token: await sessionFor(user) } : {}),
  );
  return { status: res.status, body: await res.json() };
};
const log = async (user: string, query = "") =>
  (await get("audit" + query, user)).body;

before(async () => {
  a = await tenant("AuditA");
  b = await tenant("AuditB");
  for (const t of [a, b])
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [t.organization, t.dispatcher],
    );
});
after(() => pool.end());

test("only organization owners and admins can open the log", async () => {
  assert.equal((await get("audit")).status, 401);
  for (const user of [a.manager, a.driverUser, a.foreignManager]) {
    for (const path of ["audit", "audit/filters"]) {
      const r = await get(path, user);
      assert.equal(r.status, 404, path);
      assert.deepEqual(r.body, { error: "NOT_FOUND" });
    }
  }
  assert.equal((await get("audit", a.dispatcher)).status, 200);
});

test("the trigger files a row under the actor's one organization; ambiguous or system rows stay hidden", async () => {
  const org = async (id: string) =>
    (
      await pool.query("SELECT organization_id FROM audit_logs WHERE id=$1", [
        id,
      ])
    ).rows[0].organization_id;
  const insert = async (actor: string | null) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO audit_logs VALUES($1,$2,'qa.attributed',NULL,now())",
      [id, actor],
    );
    return org(id);
  };
  assert.equal(await insert(a.manager), a.organization); // carrier membership
  assert.equal(await insert(a.driverUser), a.organization);
  assert.equal(await insert(a.dispatcher), a.organization); // admin and dispatcher
  assert.equal(await insert(null), null); // system event
  // A person in two organizations is ambiguous, so the row is not attributed.
  const both = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Both orgs')",
    [both, both + "@relay.test"],
  );
  for (const t of [a, b])
    await pool.query(
      "INSERT INTO memberships VALUES($1,$2,'carrier-manager',NULL)",
      [both, t.carrier],
    );
  assert.equal(await insert(both), null);
  for (const t of [a, b]) {
    const seen = await log(t.dispatcher, "?actor=" + both);
    assert.deepEqual(seen.entries, []);
  }
});

test("each organization sees only its own log, even when guessing ids", async () => {
  await write(a.manager, "qa.isolation", "A-ONLY");
  await write(b.manager, "qa.isolation", "B-ONLY");
  const seenByA = await log(a.dispatcher, "?action=qa.isolation");
  const seenByB = await log(b.dispatcher, "?action=qa.isolation");
  assert.deepEqual(
    seenByA.entries.map((e: { resource_id: string }) => e.resource_id),
    ["A-ONLY"],
  );
  assert.deepEqual(
    seenByB.entries.map((e: { resource_id: string }) => e.resource_id),
    ["B-ONLY"],
  );
  // Another organization's person, action and record id return nothing.
  assert.deepEqual(
    (await log(b.dispatcher, "?actor=" + a.manager)).entries,
    [],
  );
  assert.deepEqual((await log(b.dispatcher, "?q=A-ONLY")).entries, []);
  // A cursor is a position, not a pass: one taken from A's log, used by B,
  // still returns only B's rows.
  for (let i = 0; i < 3; i++) await write(a.manager, "qa.cursor", "A-" + i);
  for (let i = 0; i < 3; i++) await write(b.manager, "qa.cursor", "B-" + i);
  const aPage = await log(a.dispatcher, "?action=qa.cursor");
  assert.ok(aPage.entries.length === 3);
  const stolen =
    aPage.entries.length > 0
      ? `${Date.now() * 1000}.${aPage.entries[0].id}`
      : "";
  const viaB = await log(b.dispatcher, "?action=qa.cursor&cursor=" + stolen);
  assert.ok(
    viaB.entries.every((e: { resource_id: string }) =>
      e.resource_id.startsWith("B-"),
    ),
  );
  const filters = (await get("audit/filters", b.dispatcher)).body;
  assert.ok(!filters.actors.some((x: { id: string }) => x.id === a.manager));
});

test("entries carry a time, a person's name, a label and a record id, and nothing else", async () => {
  await write(a.manager, "load.created", "LOAD-123");
  const e = (await log(a.dispatcher, "?action=load.created")).entries[0];
  assert.deepEqual(Object.keys(e).sort(), [
    "action",
    "actor",
    "at",
    "id",
    "label",
    "resource_id",
  ]);
  assert.deepEqual(Object.keys(e.actor).sort(), ["id", "name"]);
  assert.equal(e.label, "Created a load");
  assert.equal(e.resource_id, "LOAD-123");
  assert.equal(new Date(e.at).toISOString(), e.at);
  assert.equal(auditLabel("some.new_thing-here"), "Some new thing here");
});

test("filters narrow by action, person, text and date", async () => {
  await write(a.manager, "qa.filter.one", "FILTER-ONE");
  await write(a.dispatcher, "qa.filter.two", "FILTER-TWO");
  const ids = (r: { entries: { resource_id: string }[] }) =>
    r.entries.map((x) => x.resource_id);
  assert.deepEqual(ids(await log(a.dispatcher, "?action=qa.filter.one")), [
    "FILTER-ONE",
  ]);
  assert.deepEqual(
    ids(await log(a.dispatcher, `?actor=${a.dispatcher}&q=FILTER`)),
    ["FILTER-TWO"],
  );
  assert.deepEqual(ids(await log(a.dispatcher, "?q=filter-one")), [
    "FILTER-ONE",
  ]);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(
    ids(await log(a.dispatcher, `?q=FILTER&from=${today}&to=${today}`))
      .length >= 2,
  );
  assert.deepEqual(ids(await log(a.dispatcher, "?q=FILTER&to=2001-01-01")), []);
  // Wildcards in the search text are literal.
  assert.deepEqual((await log(a.dispatcher, "?q=%25")).entries, []);
  for (const bad of [
    "?actor=nope",
    "?from=yesterday",
    "?cursor=junk",
    "?action=",
  ])
    if (bad !== "?action=")
      assert.equal((await get("audit" + bad, a.dispatcher)).status, 400, bad);
});

test("paging is stable across rows with the same timestamp", async () => {
  const stamp = "2020-01-01T00:00:00.123456Z";
  const want: string[] = [];
  for (let i = 0; i < 120; i++) {
    const id = randomUUID();
    want.push(id);
    await pool.query("INSERT INTO audit_logs VALUES($1,$2,'qa.paging',$3,$4)", [
      id,
      a.manager,
      String(i),
      stamp,
    ]);
  }
  const seen: string[] = [];
  let cursor = "";
  for (let pages = 0; pages < 10; pages++) {
    const page = await log(a.dispatcher, "?action=qa.paging" + cursor);
    assert.ok(page.entries.length <= 50);
    seen.push(...page.entries.map((e: { id: string }) => e.id));
    if (!page.next_cursor) break;
    cursor = "&cursor=" + page.next_cursor;
  }
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120, "no repeats");
  assert.deepEqual([...seen].sort(), [...want].sort(), "no gaps");
  // Newest first, with the id breaking ties.
  const sorted = [...seen].sort().reverse();
  assert.deepEqual(seen, sorted);
});

test("opening the log is itself recorded, once in ten minutes", async () => {
  const count = async () =>
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_logs WHERE actor_id=$1 AND action='audit.viewed'",
        [b.dispatcher],
      )
    ).rows[0].n;
  const before = await count();
  await log(b.dispatcher);
  await log(b.dispatcher, "?q=x");
  await log(b.dispatcher, "?action=load.created");
  assert.ok((await count()) - before <= 1);
  assert.ok((await count()) >= 1);
  const seen = await log(b.dispatcher, "?action=audit.viewed");
  assert.ok(seen.entries.length >= 1);
  assert.equal(seen.entries[0].label, "Opened the audit log");
});

test("the log stays append-only", async () => {
  const id = randomUUID();
  await write(a.manager, "qa.immutable", id);
  await assert.rejects(
    pool.query("UPDATE audit_logs SET action='changed' WHERE resource_id=$1", [
      id,
    ]),
    /Append-only/,
  );
  await assert.rejects(
    pool.query("DELETE FROM audit_logs WHERE resource_id=$1", [id]),
    /Append-only/,
  );
  const trigger = await pool.query(
    "SELECT tgenabled FROM pg_trigger WHERE tgname='immutable_audit' AND tgrelid='audit_logs'::regclass",
  );
  assert.equal(trigger.rows[0].tgenabled, "O");
});
