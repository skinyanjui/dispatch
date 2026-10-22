import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
const invoices: string[] = [];
before(async () => {
  t = await tenant("InvoiceLinks");
  // 105 invoices on the subject carrier, oldest first, so the oldest is
  // beyond the newest hundred that the overview normally returns.
  for (let i = 0; i < 105; i++) {
    const id = randomUUID();
    invoices.push(id);
    await pool.query(
      `INSERT INTO dispatch_invoices(id,carrier_id,number,status,fee_bps,total_minor,due_on,issued_at,issued_by,created_by,idempotency_key,request_hash,created_at)
       VALUES($1,$2,$3,'issued',800,10000,current_date+30,now(),$4,$4,$5,'qa',now()-($6*interval '1 minute'))`,
      [
        id,
        t.carrier,
        `LNK-${t.carrier.slice(0, 4)}-${i}`,
        t.dispatcher,
        randomUUID(),
        200 - i,
      ],
    );
  }
});
after(() => pool.end());

const get = async (path: string, user: string) => {
  const res = await GET(request(path, { token: await sessionFor(user) }));
  return { status: res.status, body: await res.json() };
};

test("an invoice link names its carrier to people who can see that carrier", async () => {
  for (const user of [t.dispatcher, t.manager]) {
    const r = await get(`dispatch-invoices/${invoices[0]}`, user);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { carrier_id: t.carrier });
  }
});

test("a missing invoice, another carrier's and a driver's read identically", async () => {
  const missing = await get(`dispatch-invoices/${randomUUID()}`, t.manager);
  const foreign = await get(
    `dispatch-invoices/${invoices[0]}`,
    t.foreignManager,
  );
  const driver = await get(`dispatch-invoices/${invoices[0]}`, t.driverUser);
  for (const r of [missing, foreign, driver]) {
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "NOT_FOUND" });
  }
  const anon = await GET(request(`dispatch-invoices/${invoices[0]}`));
  assert.equal(anon.status, 401);
});

test("the overview returns the newest hundred, plus a linked invoice beyond them", async () => {
  const plain = await get(`billing?carrier_id=${t.carrier}`, t.manager);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.invoices.length, 100);
  assert.ok(
    !plain.body.invoices.some((i: { id: string }) => i.id === invoices[0]),
  );
  const linked = await get(
    `billing?carrier_id=${t.carrier}&invoice_id=${invoices[0]}`,
    t.manager,
  );
  assert.equal(linked.body.invoices.length, 101);
  assert.ok(
    linked.body.invoices.some((i: { id: string }) => i.id === invoices[0]),
  );
});

test("a linked invoice id cannot reach another carrier's invoice", async () => {
  const other = randomUUID();
  await pool.query(
    `INSERT INTO dispatch_invoices(id,carrier_id,number,status,fee_bps,total_minor,due_on,issued_at,issued_by,created_by,idempotency_key,request_hash)
     VALUES($1,$2,$3,'issued',800,1,current_date+30,now(),$4,$4,$5,'qa')`,
    [
      other,
      t.foreign,
      "LNK-OTHER-" + other.slice(0, 6),
      t.dispatcher,
      randomUUID(),
    ],
  );
  const r = await get(
    `billing?carrier_id=${t.carrier}&invoice_id=${other}`,
    t.manager,
  );
  assert.equal(r.status, 200);
  assert.ok(!r.body.invoices.some((i: { id: string }) => i.id === other));
  const bad = await get(
    `billing?carrier_id=${t.carrier}&invoice_id=nope`,
    t.manager,
  );
  assert.equal(bad.status, 400);
});
