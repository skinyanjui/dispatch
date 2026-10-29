import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  cancelChange,
  decideChange,
  expireStaleChanges,
  listChanges,
  payoutDetails,
  pendingCount,
  requestPayoutChange,
} from "../../src/lib/change-control";
import { mfaEnable, mfaSetup } from "../../src/lib/account";
import { codeAt, stepAt } from "../../src/lib/totp";
import { authorityStatus } from "../../src/lib/authority";
import { createContact, updateContact } from "../../src/lib/contacts";
import { saveCompany } from "../../src/lib/onboarding";
import { detail, mutate } from "../../src/lib/loads";
import { editLoad } from "../../src/lib/load-changes";
import {
  bookedLoad,
  request,
  sessionFor,
  tenant,
  withPassword,
} from "./fixtures";

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
const approve = async (id: string, user = t.manager) =>
  decideChange(user, id, {
    decision: "approve",
    verification: "callback",
    password: await withPassword(user),
  });

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

test("unlinking or moving a carrier contact is held too, so its details cannot be changed freely afterwards", async () => {
  const base = {
    kind: "receiver",
    name: "Dock Office",
    company: "",
    notes: "",
    sms_consent: false,
    sms_consent_note: "",
  };
  const make = () =>
    createContact(t.dispatcher, {
      idempotency_key: randomUUID(),
      ...base,
      email: "dock@receiver.test",
      phone: "615-555-0100",
      carrier_id: t.carrier,
    });
  const row = async (id: string) =>
    (
      await pool.query(
        "SELECT email,phone,carrier_id,version FROM contacts WHERE id=$1",
        [id],
      )
    ).rows[0];
  const edit = (id: string, version: number, over: Record<string, unknown>) =>
    updateContact(t.dispatcher, id, {
      ...base,
      email: "dock@receiver.test",
      phone: "615-555-0100",
      carrier_id: t.carrier,
      version,
      ...over,
    }) as Promise<{ pending_approval?: boolean; change_id?: string }>;

  // Unlinking alone needs a reason and waits; the contact stays linked.
  const a = await make();
  await assert.rejects(edit(a.id, 1, { carrier_id: null }), {
    code: "REASON_REQUIRED",
  });
  const unlink = await edit(a.id, 1, {
    carrier_id: null,
    change_reason: "No longer ours",
  });
  assert.equal(unlink.pending_approval, true);
  assert.equal((await row(a.id)).carrier_id, t.carrier);
  // While it waits, the same trick is not open: a second edit is refused, not applied.
  await assert.rejects(
    edit(a.id, 2, {
      carrier_id: null,
      phone: "999-555-0000",
      change_reason: "x",
    }),
    { code: "CHANGE_PENDING" },
  );
  assert.equal((await row(a.id)).phone, "615-555-0100");
  await approve(unlink.change_id!);
  assert.equal((await row(a.id)).carrier_id, null);

  // Unlinking and changing the details in one call changes nothing until approved.
  const b = await make();
  const both = await edit(b.id, 1, {
    carrier_id: null,
    email: "evil@receiver.test",
    phone: "999-555-0000",
    change_reason: "Moved",
  });
  assert.deepEqual(
    [(await row(b.id)).carrier_id, (await row(b.id)).phone],
    [t.carrier, "615-555-0100"],
  );
  await approve(both.change_id!);
  assert.deepEqual(
    [
      (await row(b.id)).carrier_id,
      (await row(b.id)).email,
      (await row(b.id)).phone,
    ],
    [null, "evil@receiver.test", "999-555-0000"],
  );

  // Moving it to another carrier with new details is held, and only someone who
  // answers for both carriers can approve it.
  const m = await make();
  const move = await edit(m.id, 1, {
    carrier_id: t.foreign,
    phone: "999-555-0111",
    change_reason: "Now works with the other carrier",
  });
  assert.equal(move.pending_approval, true);
  assert.deepEqual(
    [(await row(m.id)).carrier_id, (await row(m.id)).phone],
    [t.carrier, "615-555-0100"],
  );
  await assert.rejects(approve(move.change_id!), {
    code: "TARGET_CARRIER_APPROVAL_REQUIRED",
  });
  assert.equal((await row(m.id)).carrier_id, t.carrier);
  const admin = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'not-a-login-fixture','Org admin')",
    [admin, admin + "@relay.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [t.organization, admin],
  );
  await approve(move.change_id!, admin);
  assert.deepEqual(
    [(await row(m.id)).carrier_id, (await row(m.id)).phone],
    [t.foreign, "999-555-0111"],
  );
  // Someone who cannot reach the target carrier cannot even ask for the move.
  const c2 = await make();
  await assert.rejects(
    updateContact(t.manager, c2.id, {
      ...base,
      email: "dock@receiver.test",
      phone: "615-555-0100",
      carrier_id: t.foreign,
      version: 1,
      change_reason: "x",
    }),
    { code: "NOT_FOUND" },
  );
  // A contact that was never linked to a carrier is still edited directly.
  const free = await createContact(t.dispatcher, {
    idempotency_key: randomUUID(),
    ...base,
    kind: "broker",
    email: "b@broker.test",
    phone: "",
    carrier_id: null,
  });
  const direct = await edit(free.id, 1, {
    kind: "broker",
    email: "c@broker.test",
    phone: "",
    carrier_id: null,
  });
  assert.equal(direct.pending_approval, undefined);
});

test("once a carrier is set up, its name, contact email, phone and USDOT number change only with a second person", async () => {
  const fresh = await tenant("CarrierProfile");
  const profile = async () =>
    (
      await pool.query(
        `SELECT p.version,p.step,p.contact_name,p.contact_email,p.phone,p.usdot,c.name
         FROM carrier_profiles p JOIN carriers c ON c.id=p.carrier_id WHERE p.carrier_id=$1`,
        [fresh.carrier],
      )
    ).rows[0];
  await pool.query(
    "INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone,usdot,step) VALUES($1,'Casey','casey@carrier.test','800-555-0100','1000001','team')",
    [fresh.carrier],
  );
  const save = async (
    over: Record<string, unknown>,
    user = fresh.dispatcher,
  ) => {
    const p = await profile();
    return saveCompany(user, fresh.carrier, {
      name: p.name,
      contact_name: p.contact_name,
      contact_email: p.contact_email,
      phone: p.phone,
      usdot: p.usdot,
      version: p.version,
      key: randomUUID(),
      ...over,
    }) as Promise<{ pending_approval?: boolean; change_id?: string }>;
  };
  // While setup is under way the dispatcher fills the details in directly.
  const early = await save({ contact_email: "casey2@carrier.test" });
  assert.equal(early.pending_approval, undefined);
  assert.equal((await profile()).contact_email, "casey2@carrier.test");

  await pool.query(
    "UPDATE carrier_profiles SET step='complete' WHERE carrier_id=$1",
    [fresh.carrier],
  );
  // The contact person's own name is not sensitive.
  assert.equal(
    (await save({ contact_name: "Casey Lane" })).pending_approval,
    undefined,
  );
  assert.equal((await profile()).contact_name, "Casey Lane");

  // Email, phone, USDOT and the carrier's name wait, and need a reason.
  for (const over of [
    { contact_email: "attacker@evil.test" },
    { phone: "999-555-0000" },
    { usdot: "1000002" },
    { name: "Renamed Transport" },
  ])
    await assert.rejects(save(over), { code: "REASON_REQUIRED" });
  const held = await save({
    contact_name: "Casey L.",
    contact_email: "attacker@evil.test",
    usdot: "1000002",
    name: "Renamed Transport",
    change_reason: "Carrier asked us to update its file",
  });
  assert.equal(held.pending_approval, true);
  const still = await profile();
  assert.deepEqual(
    [still.contact_email, still.usdot, still.name, still.contact_name],
    ["casey2@carrier.test", "1000001", still.name, "Casey L."],
  );
  assert.notEqual(still.name, "Renamed Transport");
  // The person who asked cannot approve it; the carrier's manager can.
  await assert.rejects(approve(held.change_id!, fresh.dispatcher), {
    code: "NOT_FOUND",
  });
  await approve(held.change_id!, fresh.manager);
  const done = await profile();
  assert.deepEqual(
    [done.contact_email, done.usdot, done.name],
    ["attacker@evil.test", "1000002", "Renamed Transport"],
  );
  // A changed USDOT number is not covered by the old lookup (ADR 0070).
  assert.equal(
    (await authorityStatus(fresh.manager, fresh.carrier)).state,
    "unchecked",
  );

  // A request goes stale if the record moved on.
  const second = await save({
    phone: "111-555-0000",
    change_reason: "New office line",
  });
  await pool.query(
    "UPDATE carrier_profiles SET phone='222-555-0000' WHERE carrier_id=$1",
    [fresh.carrier],
  );
  assert.equal(
    ((await approve(second.change_id!, fresh.manager)) as { status: string })
      .status,
    "stale",
  );
  assert.equal((await profile()).phone, "222-555-0000");
  // Another carrier's people cannot ask or decide.
  await assert.rejects(
    save({ phone: "1", change_reason: "x" }, fresh.foreignManager),
    { code: "NOT_FOUND" },
  );
});

test("an approval needs the approver's password again, and a code if they use two-step verification", async () => {
  const fresh = await tenant("StepUp");
  const ask = async () =>
    (
      (await requestPayoutChange(fresh.dispatcher, {
        carrier_id: fresh.carrier,
        payee_name: "Step Up Payee",
        method: "ach",
        account_last4: "1234",
        reason: "Moved banks",
        key: randomUUID(),
      })) as { id: string }
    ).id;
  const decide = (id: string, extra: Record<string, unknown>) =>
    decideChange(fresh.manager, id, {
      decision: "approve",
      verification: "callback",
      ...extra,
    });
  const password = await withPassword(fresh.manager);
  const id = await ask();
  // A session alone is not enough.
  await assert.rejects(decide(id, {}), { code: "STEP_UP_REQUIRED" });
  await assert.rejects(decide(id, { password: "not the password" }), {
    code: "STEP_UP_FAILED",
  });
  // An account with no usable password cannot approve either.
  await pool.query("UPDATE users SET password_hash='!' WHERE id=$1", [
    fresh.manager,
  ]);
  await assert.rejects(decide(id, { password }), { code: "STEP_UP_FAILED" });
  await withPassword(fresh.manager);
  // Rejecting is always allowed: stopping a change never needs the extra proof.
  const other = await ask().catch(() => null);
  assert.equal(other, null); // one pending request at a time
  // Failed attempts are limited per person: after six wrong tries in five
  // minutes even the right password is refused for a while.
  for (let i = 0; i < 4; i++)
    await assert.rejects(decide(id, { password: "wrong " + i }), {
      code: "STEP_UP_FAILED",
    });
  await assert.rejects(decide(id, { password }), { code: "TRY_AGAIN_LATER" });
  // ...so a fresh approver proves it works with the right password.
  const admin = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Second approver')",
    [admin, admin + "@relay.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [fresh.organization, admin],
  );
  const adminPassword = await withPassword(admin);
  // With two-step verification on, a code is needed as well.
  const { secret } = await mfaSetup(admin);
  const enrolled = stepAt(Date.now());
  await mfaEnable(admin, { code: codeAt(secret, enrolled) });
  await assert.rejects(
    decideChange(admin, id, {
      decision: "approve",
      verification: "callback",
      password: adminPassword,
    }),
    { code: "MFA_CODE_REQUIRED" },
  );
  await assert.rejects(
    decideChange(admin, id, {
      decision: "approve",
      verification: "callback",
      password: adminPassword,
      code: "000000" === codeAt(secret, enrolled + 1) ? "111111" : "000000",
    }),
    { code: "INVALID_MFA_CODE" },
  );
  const done = (await decideChange(admin, id, {
    decision: "approve",
    verification: "callback",
    password: adminPassword,
    code: codeAt(secret, enrolled + 1),
  })) as { status: string };
  assert.equal(done.status, "approved");
  // Rejecting needs no password.
  const next = await ask();
  assert.equal(
    (
      (await decideChange(fresh.manager, next, { decision: "reject" })) as {
        status: string;
      }
    ).status,
    "rejected",
  );
});

test("approvers are told when a request waits, and a request nobody decides lapses", async () => {
  const fresh = await tenant("Waiting");
  const admin = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Org admin')",
    [admin, admin + "@relay.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [fresh.organization, admin],
  );
  const ask = () =>
    requestPayoutChange(fresh.dispatcher, {
      carrier_id: fresh.carrier,
      payee_name: "Lapsing Payee",
      method: "ach",
      account_last4: "",
      reason: "Moved banks",
      key: randomUUID(),
    }) as Promise<{ id: string }>;
  const told = async (user: string, id?: string) =>
    (
      await pool.query(
        "SELECT subject FROM notifications WHERE recipient_user_id=$1 AND kind='approval_request'" +
          (id ? " AND dedupe_key LIKE $2" : ""),
        id ? [user, "%" + id + "%"] : [user],
      )
    ).rowCount;
  const first = await ask();
  // The carrier's manager and the organization admin are told; the requester is not.
  assert.equal(await told(fresh.manager, first.id), 1);
  assert.equal(await told(admin, first.id), 1);
  assert.equal(await told(fresh.dispatcher), 0);
  assert.equal(await told(fresh.driverUser), 0);
  // The banner reads a count by carrier.
  const waiting = await pendingCount(fresh.manager);
  assert.deepEqual(
    waiting.carriers.map((x) => [x.carrier_id, x.count]),
    [[fresh.carrier, 1]],
  );
  assert.equal((await pendingCount(fresh.dispatcher)).pending, 0);

  // While it waits, asking again is refused; once it has lapsed it is not.
  await assert.rejects(ask(), { code: "CHANGE_PENDING" });
  await pool.query(
    "UPDATE sensitive_changes SET requested_at=now()-interval '8 days' WHERE id=$1",
    [first.id],
  );
  assert.equal((await pendingCount(fresh.manager)).pending, 0);
  const lapsed = (
    await listChanges(fresh.dispatcher, fresh.carrier)
  ).changes.find((c) => c.id === first.id)!;
  assert.deepEqual([lapsed.status, lapsed.expired], ["cancelled", true]);
  const again = await ask();
  assert.notEqual(again.id, first.id);
  // The daily job closes lapsed requests nobody asked about again, and audits it.
  await pool.query(
    "UPDATE sensitive_changes SET requested_at=now()-interval '9 days' WHERE id=$1",
    [again.id],
  );
  assert.ok((await expireStaleChanges()) >= 1);
  assert.equal(
    (
      await pool.query("SELECT status FROM sensitive_changes WHERE id=$1", [
        again.id,
      ])
    ).rows[0].status,
    "cancelled",
  );
  const actions = (
    await pool.query("SELECT action FROM audit_logs WHERE resource_id=$1", [
      fresh.carrier,
    ])
  ).rows.map((r) => r.action);
  assert.ok(actions.includes("change.expired"));
});
