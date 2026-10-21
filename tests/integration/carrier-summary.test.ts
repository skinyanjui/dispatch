import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

after(() => pool.end());
let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
const extra: Record<string, string> = {};

async function addCarrier(
  name: string,
  agreement: "expired" | "expiring" | "none",
) {
  const id = randomUUID();
  await pool.query("INSERT INTO carriers VALUES($1,$2,$3)", [
    id,
    t.organization,
    name,
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)", [
    t.dispatcher,
    id,
  ]);
  if (agreement !== "none")
    await pool.query(
      `INSERT INTO carrier_dispatch_authorizations(id,carrier_id,agreement_ref,verified_at,effective_at,expires_at)
      VALUES($1,$2,'QA',now()-interval '400 days',now()-interval '400 days',$3)`,
      [
        randomUUID(),
        id,
        agreement === "expired"
          ? new Date(Date.now() - 86400000 * 5)
          : new Date(Date.now() + 86400000 * 10),
      ],
    );
  return id;
}

before(async () => {
  t = await tenant("Summary");
  other = await tenant("SummaryOther");
  extra.expired = await addCarrier("Zed Expired QA", "expired");
  extra.expiring = await addCarrier("Yak Expiring QA", "expiring");
  extra.none = await addCarrier("Xan None QA", "none");
  // Carrier A: one active load, one delivered, one cancelled, one open and one resolved exception.
  const active = await bookedLoad(t.dispatcher, t.carrier);
  const delivered = await bookedLoad(t.dispatcher, t.carrier);
  const cancelled = await bookedLoad(t.dispatcher, t.carrier);
  await pool.query("UPDATE loads SET stage='delivered' WHERE id=$1", [
    delivered.id,
  ]);
  await pool.query(
    "UPDATE loads SET cancelled_at=now(),cancelled_by=$2,cancel_reason='QA' WHERE id=$1",
    [cancelled.id, t.dispatcher],
  );
  for (const [status, resolved] of [
    ["open", false],
    ["resolved", true],
  ] as const)
    await pool.query(
      `INSERT INTO load_exceptions(id,load_id,carrier_id,type,severity,status,summary,opened_by,idempotency_key,request_hash,resolved_by,resolved_at,resolution)
      VALUES($1,$2,$3,'delay','low',$4,'QA',$5,$6,'x',$7,$8,$9)`,
      [
        randomUUID(),
        active.id,
        t.carrier,
        status,
        t.dispatcher,
        randomUUID(),
        resolved ? t.dispatcher : null,
        resolved ? new Date() : null,
        resolved ? "Done" : null,
      ],
    );
});

const fetchSummary = async (user: string) =>
  GET(request("carriers/summary", { token: await sessionFor(user) }));

test("each carrier reports authorization, loads, exceptions and drivers", async () => {
  const res = await fetchSummary(t.dispatcher);
  assert.equal(res.status, 200);
  const { carriers } = await res.json();
  const by = (id: string) => carriers.find((c: { id: string }) => c.id === id);
  const a = by(t.carrier);
  assert.equal(a.authorization.state, "current");
  assert.deepEqual(a.loads, {
    active: 1,
    total: 3,
    delivered: 1,
    cancelled: 1,
  });
  assert.equal(a.open_exceptions, 1);
  assert.equal(a.drivers, 2);
  assert.equal(by(extra.expired).authorization.state, "expired");
  assert.equal(by(extra.expiring).authorization.state, "expiring");
  assert.ok(by(extra.expiring).authorization.expires_at);
  assert.equal(by(extra.none).authorization.state, "none");
  assert.equal(by(extra.none).authorization.expires_at, null);
});

test("a manager sees only their own carrier; another organization's carriers never appear", async () => {
  const { carriers } = await (await fetchSummary(t.manager)).json();
  assert.deepEqual(
    carriers.map((c: { id: string }) => c.id),
    [t.carrier],
  );
  assert.equal(carriers[0].role, "carrier-manager");
  const mine = await (await fetchSummary(other.dispatcher)).json();
  const ids = mine.carriers.map((c: { id: string }) => c.id);
  assert.ok(!ids.includes(t.carrier) && !ids.includes(extra.none));
});

test("drivers and signed-out callers have no carrier overview", async () => {
  assert.equal((await fetchSummary(t.driverUser)).status, 404);
  assert.equal((await GET(request("carriers/summary"))).status, 401);
});
