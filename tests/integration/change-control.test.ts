import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  cancelChange,
  decideChange,
  listChanges,
  payoutDetails,
  pendingCount,
  requestPayoutChange,
} from "../../src/lib/change-control";
import { createContact, updateContact } from "../../src/lib/contacts";
import { detail, mutate } from "../../src/lib/loads";
import { editLoad } from "../../src/lib/load-changes";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("ChangeControl");
});
after(() => pool.end());

const payout = (over: Record<string, unknown> = {}) => ({
  carrier_id: t.carrier,
  payee_name: "Fictional Hauling LLC",
  method: "ach",
  account_last4: "4321",
  reason: "Carrier moved banks",
  key: randomUUID(),
  ...over,
});
const ask = (over: Record<string, unknown> = {}, user = t.dispatcher) =>
  requestPayoutChange(user, payout(over)) as Promise<{ id: string }>;
const approve = (id: string, user = t.manager) =>
  decideChange(user, id, { decision: "approve", verification: "callback" });

test("payout details change only when a different person approves after verifying", async () => {
  process.env.RELAY_PAYOUT_COOLING_HOURS = "24";
  const { id } = await ask();
  // Asking changes nothing.
  assert.equal(await payoutDetails(pool, t.carrier), null);
  // The requester cannot approve their own request, with or without a role.
  await assert.rejects(approve(id, t.dispatcher), { code: "NOT_FOUND" });
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [t.organization, t.dispatcher],
  );
  await assert.rejects(approve(id, t.dispatcher), { code: "SAME_PERSON" });
  // Approval must say how it was verified.
  await assert.rejects(decideChange(t.manager, id, { decision: "approve" }), {
    code: "VERIFICATION_REQUIRED",
  });
  const done = (await approve(id)) as { status: string; effective_at: string };
  assert.equal(done.status, "approved");
  // Cooling off: recorded, but not yet in force.
  const now = await payoutDetails(pool, t.carrier);
  assert.equal(now?.account_last4, "4321");
  assert.equal(now?.cooling_off, true);
  const hours = (Date.parse(done.effective_at) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24);
  // Decided once.
  await assert.rejects(approve(id), { code: "CHANGE_DECIDED" });
  // The next change, with no cooling-off configured, counts at once.
  process.env.RELAY_PAYOUT_COOLING_HOURS = "0";
  const next = await ask({
    payee_name: "Fictional Hauling Two",
    method: "wire",
  });
  await approve(next.id);
  const after = await payoutDetails(pool, t.carrier);
  assert.equal(after?.payee_name, "Fictional Hauling Two");
  assert.equal(after?.cooling_off, false);
  delete process.env.RELAY_PAYOUT_COOLING_HOURS;
});

test("the database itself refuses an approval by the requester", async () => {
  const { id } = await ask({ payee_name: "Another Payee" });
  await assert.rejects(
    pool.query(
      `UPDATE sensitive_changes SET status='approved',decided_by=requested_by,decided_at=now(),
        verification='callback',effective_at=now() WHERE id=$1`,
      [id],
    ),
    { code: "23514" },
  );
  await cancelChange(t.dispatcher, id);
});

test("reject, withdraw, duplicates and strangers", async () => {
  const { id } = await ask({ payee_name: "Rejected Payee" });
  // One request per carrier at a time.
  await assert.rejects(ask({ payee_name: "Second" }), {
    code: "CHANGE_PENDING",
  });
  // Only the requester withdraws; anyone else, including the manager, is told it is not theirs.
  await assert.rejects(cancelChange(t.manager, id), { code: "NOT_FOUND" });
  await assert.rejects(cancelChange(t.foreignManager, id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    decideChange(t.foreignManager, id, { decision: "reject" }),
    {
      code: "NOT_FOUND",
    },
  );
  const before = await payoutDetails(pool, t.carrier);
  await decideChange(t.manager, id, {
    decision: "reject",
    note: "Not what they said on the phone",
  });
  assert.deepEqual(await payoutDetails(pool, t.carrier), before);
  // After a decision the slot is free again.
  const again = await ask({ payee_name: "Third" });
  await cancelChange(t.dispatcher, again.id);
  await assert.rejects(cancelChange(t.dispatcher, again.id), {
    code: "CHANGE_DECIDED",
  });
});

test("a carrier contact's phone or email change waits for approval and goes stale if the record moved", async () => {
  const contact = await createContact(t.dispatcher, {
    idempotency_key: randomUUID(),
    kind: "receiver",
    name: "Dock Office",
    company: "Fictional Receiving",
    email: "dock@receiver.test",
    phone: "615-555-0100",
    notes: "",
    carrier_id: t.carrier,
    sms_consent: false,
    sms_consent_note: "",
  });
  const fields = (over: Record<string, unknown>) => ({
    kind: "receiver",
    name: "Dock Office",
    company: "Fictional Receiving",
    email: "dock@receiver.test",
    phone: "615-555-0100",
    notes: "",
    carrier_id: t.carrier,
    sms_consent: false,
    sms_consent_note: "",
    ...over,
  });
  // A reason is required for the held fields.
  await assert.rejects(
    updateContact(t.dispatcher, contact.id, {
      ...fields({ phone: "615-555-0199" }),
      version: 1,
    }),
    { code: "REASON_REQUIRED" },
  );
  const held = (await updateContact(t.dispatcher, contact.id, {
    ...fields({ phone: "615-555-0199", notes: "Gate code 12" }),
    version: 1,
    change_reason: "They called from a new office line",
  })) as { pending_approval?: boolean; change_id?: string };
  assert.equal(held.pending_approval, true);
  const row = (
    await pool.query("SELECT phone,notes FROM contacts WHERE id=$1", [
      contact.id,
    ])
  ).rows[0];
  // Notes applied now, the phone not yet.
  assert.deepEqual(row, { phone: "615-555-0100", notes: "Gate code 12" });
  await approve(held.change_id!);
  assert.equal(
    (await pool.query("SELECT phone FROM contacts WHERE id=$1", [contact.id]))
      .rows[0].phone,
    "615-555-0199",
  );
  // A second request goes stale when the email changes underneath it.
  const v = (
    await pool.query("SELECT version FROM contacts WHERE id=$1", [contact.id])
  ).rows[0].version;
  const stale = (await updateContact(t.dispatcher, contact.id, {
    ...fields({ phone: "615-555-0177", notes: "Gate code 12" }),
    version: v,
    change_reason: "Another number",
  })) as { change_id: string };
  await pool.query(
    "UPDATE contacts SET email='changed@receiver.test' WHERE id=$1",
    [contact.id],
  );
  const out = (await approve(stale.change_id)) as { status: string };
  assert.equal(out.status, "stale");
  assert.equal(
    (await pool.query("SELECT phone FROM contacts WHERE id=$1", [contact.id]))
      .rows[0].phone,
    "615-555-0199",
  );
  // Contacts of no carrier are unaffected.
  const open = await createContact(t.dispatcher, {
    idempotency_key: randomUUID(),
    kind: "broker",
    name: "Open Broker",
    company: "",
    email: "a@broker.test",
    phone: "",
    notes: "",
    carrier_id: null,
    sms_consent: false,
    sms_consent_note: "",
  });
  const direct = (await updateContact(t.dispatcher, open.id, {
    ...fields({
      kind: "broker",
      name: "Open Broker",
      company: "",
      email: "b@broker.test",
      phone: "",
      carrier_id: null,
    }),
    version: 1,
  })) as { pending_approval?: boolean };
  assert.equal(direct.pending_approval, undefined);
});

test("a stop address changed after dispatch is a reroute for a second person, and stale if it moved", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.driver,
  });
  const d = await detail(t.dispatcher, load.id);
  // While still booked, addresses change freely.
  const free = await editLoad(t.dispatcher, load.id, {
    version: d.version,
    stops: [{ id: d.stops[0].id, address: "Chicago, IL (Dock 2)" }],
  });
  assert.equal(
    (free as { pending_approval?: boolean }).pending_approval,
    undefined,
  );
  const staged = await mutate(t.dispatcher, load.id, "milestones", {
    version: (await detail(t.dispatcher, load.id)).version,
    stage: "dispatched",
  });
  const held = (await editLoad(t.dispatcher, load.id, {
    version: staged.version,
    reason: "Shipper rerouted to the south yard",
    stops: [{ id: d.stops[1].id, address: "Memphis, TN" }],
  })) as { pending_approval?: boolean; change_id: string };
  assert.equal(held.pending_approval, true);
  assert.equal(
    (await detail(t.dispatcher, load.id)).stops[1].address,
    "Nashville, TN",
  );
  // The driver and every foreign person cannot decide it.
  await assert.rejects(approve(held.change_id, t.driverUser), {
    code: "NOT_FOUND",
  });
  await assert.rejects(approve(held.change_id, t.foreignManager), {
    code: "NOT_FOUND",
  });
  await approve(held.change_id);
  assert.equal(
    (await detail(t.dispatcher, load.id)).stops[1].address,
    "Memphis, TN",
  );
  // A second reroute is stale if the stop moved some other way first.
  const v = (await detail(t.dispatcher, load.id)).version;
  const second = (await editLoad(t.dispatcher, load.id, {
    version: v,
    reason: "Back to Nashville",
    stops: [{ id: d.stops[1].id, address: "Nashville, TN" }],
  })) as { change_id: string };
  await pool.query(
    "UPDATE load_stops SET address='Knoxville, TN' WHERE id=$1",
    [d.stops[1].id],
  );
  assert.equal(
    ((await approve(second.change_id)) as { status: string }).status,
    "stale",
  );
  assert.equal(
    (await detail(t.dispatcher, load.id)).stops[1].address,
    "Knoxville, TN",
  );
});

test("HTTP: lists, counts and decides only for people of the carrier; drivers and strangers get 404", async () => {
  const { id } = await ask({ payee_name: "HTTP Payee" });
  const call = async (
    method: "GET" | "POST",
    path: string,
    user: string,
    json?: unknown,
  ) => {
    const req = request(path, {
      method,
      token: await sessionFor(user),
      ...(json ? { json } : {}),
    });
    const res = await (method === "GET" ? GET(req) : POST(req));
    return { status: res.status, body: await res.json() };
  };
  const mine = await call(
    "GET",
    "change-control?carrier_id=" + t.carrier,
    t.dispatcher,
  );
  assert.equal(mine.status, 200);
  const item = mine.body.changes.find((c: { id: string }) => c.id === id);
  assert.equal(item.status, "pending");
  assert.equal(item.can_cancel, true);
  assert.equal(item.can_decide, false);
  const theirs = await call(
    "GET",
    "change-control?carrier_id=" + t.carrier,
    t.manager,
  );
  const seen = theirs.body.changes.find((c: { id: string }) => c.id === id);
  assert.equal(seen.can_decide, true);
  assert.equal(theirs.body.can_decide, true);
  assert.equal(
    (
      (await call("GET", "change-control/pending", t.manager)).body as {
        pending: number;
      }
    ).pending >= 1,
    true,
  );
  for (const user of [t.driverUser, t.foreignManager]) {
    assert.equal(
      (await call("GET", "change-control?carrier_id=" + t.carrier, user))
        .status,
      404,
    );
    assert.equal(
      (
        await call("POST", `change-control/${id}/decision`, user, {
          decision: "reject",
        })
      ).status,
      404,
    );
  }
  assert.equal(
    (
      await call("POST", `change-control/${id}/decision`, t.dispatcher, {
        decision: "approve",
        verification: "callback",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("POST", `change-control/${id}/decision`, t.manager, {
        decision: "reject",
        extra: 1,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", `change-control/${id}/decision`, t.manager, {
        decision: "reject",
      })
    ).status,
    200,
  );
  assert.equal((await pendingCount(t.manager)).pending >= 0, true);
  assert.equal(
    (await listChanges(t.manager, t.carrier)).payout_details !== undefined,
    true,
  );
});
