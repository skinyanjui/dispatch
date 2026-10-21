import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import {
  digest,
  hashPassword,
  session,
  verifyPassword,
} from "../../src/lib/auth";
import {
  createCarrier,
  carrierSetup,
  saveCompany,
  saveAgreement,
  completeSetup,
  inviteManager,
  inviteDriver,
  inspectInvite,
  acceptInvite,
} from "../../src/lib/onboarding";
import { createLoad, mutate, detail } from "../../src/lib/loads";
import { POST } from "../../src/app/api/[...path]/route";
import { NextRequest } from "next/server";
const admin = randomUUID(),
  outsider = randomUUID(),
  manager = randomUUID(),
  driverUser = randomUUID(),
  org = randomUUID(),
  foreignOrg = randomUUID(),
  base = randomUUID(),
  foreign = randomUUID();
const password = "FictionalOnboardingTest2026";
const secret = () => randomBytes(32).toString("hex");
const address = () => randomUUID() + "@relay.test";
const company = (email = address()) => ({
  name: "Onboarding QA " + randomUUID().slice(0, 8),
  contact_name: "Taylor QA",
  contact_email: email,
  phone: "",
  usdot: "",
  organization_id: org,
  key: randomUUID(),
});
const agreement = () => ({
  reference: "Fictional signed QA agreement",
  effective_date: new Date().toISOString().slice(0, 10),
  through_date: new Date(Date.now() + 86400000 * 365)
    .toISOString()
    .slice(0, 10),
  confirmed: true,
  key: randomUUID(),
});
const join = (token: string) => ({
  token,
  name: "Taylor QA",
  password,
  timezone: "America/Chicago",
  phone: "",
});
before(async () => {
  for (const id of [org, foreignOrg])
    await pool.query("INSERT INTO organizations VALUES($1,'Onboarding QA')", [
      id,
    ]);
  for (const [id, o] of [
    [base, org],
    [foreign, foreignOrg],
  ])
    await pool.query("INSERT INTO carriers VALUES($1,$2,'Scope QA')", [id, o]);
  for (const id of [admin, outsider, manager, driverUser])
    await pool.query("INSERT INTO users VALUES($1,$2,$3,'Onboarding user')", [
      id,
      id + "@relay.test",
      hashPassword(password),
    ]);
  for (const [user, c, role] of [
    [admin, base, "dispatcher"],
    [outsider, foreign, "dispatcher"],
    [manager, base, "carrier-manager"],
  ])
    await pool.query("INSERT INTO memberships VALUES($1,$2,$3,NULL)", [
      user,
      c,
      role,
    ]);
  const driver = randomUUID();
  await pool.query(
    "INSERT INTO drivers(id,carrier_id,name) VALUES($1,$2,'Scope driver')",
    [driver, base],
  );
  await pool.query("INSERT INTO memberships VALUES($1,$2,'driver',$3)", [
    driverUser,
    base,
    driver,
  ]);
});
after(() => pool.end());
async function create(email?: string) {
  const result = await createCarrier(admin, company(email));
  return String(result.id);
}
async function load(id: string) {
  return createLoad(
    admin,
    {
      carrierId: id,
      reference: randomUUID(),
      source: "Fictional onboarding QA",
      amountMinor: 100,
      stops: [
        {
          kind: "pickup",
          address: "Chicago",
          timezone: "UTC",
          windowStart: "2026-11-05T10:00:00Z",
          windowEnd: "2026-11-05T11:00:00Z",
        },
        {
          kind: "delivery",
          address: "Nashville",
          timezone: "UTC",
          windowStart: "2026-11-06T10:00:00Z",
          windowEnd: "2026-11-06T11:00:00Z",
        },
      ],
    },
    randomUUID(),
  );
}

test("carrier drafts are scoped to a dispatcher's organization and replay without duplication", async () => {
  const input = company();
  const [a, b] = await Promise.all([
    createCarrier(admin, input),
    createCarrier(admin, input),
  ]);
  assert.deepEqual(a, b);
  await assert.rejects(createCarrier(manager, company()), /NOT_FOUND/);
  await assert.rejects(createCarrier(driverUser, company()), /NOT_FOUND/);
  await assert.rejects(createCarrier(outsider, company()), /NOT_FOUND/);
  await assert.rejects(
    createCarrier(admin, { ...input, name: "Changed" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const d = await carrierSetup(admin, String(a.id));
  assert.equal(d.profile.step, "agreement");
  assert.equal(d.agreement, null);
  await assert.rejects(carrierSetup(outsider, String(a.id)), /NOT_FOUND/);
  await assert.rejects(load(String(a.id)), /CARRIER_AUTHORIZATION_REQUIRED/);
});
test("agreement verification is dispatcher-only, audited, and unlocks booking without fabricated checks", async () => {
  const id = await create();
  await pool.query(
    "INSERT INTO memberships VALUES($1,$2,'carrier-manager',NULL)",
    [manager, id],
  );
  await assert.rejects(saveAgreement(manager, id, agreement()), /NOT_FOUND/);
  await assert.rejects(saveAgreement(outsider, id, agreement()), /NOT_FOUND/);
  const data = agreement();
  await saveAgreement(admin, id, data);
  await saveAgreement(admin, id, data);
  assert.equal((await carrierSetup(admin, id)).agreement.current, true);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM carrier_dispatch_authorizations WHERE carrier_id=$1",
        [id],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT verified_by FROM carrier_dispatch_authorizations WHERE carrier_id=$1",
        [id],
      )
    ).rows[0].verified_by,
    admin,
  );
  const l = await load(id);
  assert.equal(l.stage, "booked");
  await completeSetup(manager, id);
  assert.equal((await carrierSetup(admin, id)).profile.step, "complete");
  await assert.rejects(
    saveAgreement(admin, id, { ...agreement(), through_date: "2020-01-01" }),
    /INVALID_AGREEMENT_DATES/,
  );
  await assert.rejects(
    saveAgreement(admin, id, { ...agreement(), confirmed: false }),
    (e) => e instanceof Error && e.name === "ZodError",
  );
});
test("saved details survive revisits and optimistic conflicts do not overwrite another editor", async () => {
  const id = await create();
  const data = await carrierSetup(admin, id);
  const input = {
    name: data.carrier.name,
    contact_name: "Updated",
    contact_email: address(),
    phone: "",
    usdot: "1234567",
    version: 1,
    key: randomUUID(),
  };
  await saveCompany(admin, id, input);
  await saveCompany(admin, id, input);
  assert.equal((await carrierSetup(admin, id)).profile.version, 2);
  await assert.rejects(
    saveCompany(admin, id, {
      ...input,
      key: randomUUID(),
      contact_name: "Stale",
    }),
    /VERSION_CONFLICT/,
  );
  assert.equal((await carrierSetup(admin, id)).profile.contact_name, "Updated");
});
test("manager invitations grant only their stored carrier role and store no plaintext invitation secret", async () => {
  const email = address(),
    id = await create(email),
    token = secret(),
    input = { key: randomUUID(), token };
  const a = await inviteManager(admin, id, input),
    b = await inviteManager(admin, id, input);
  assert.deepEqual(a, b);
  const preview = await inspectInvite({ token });
  assert.equal(preview.email, email);
  assert.equal(preview.account_exists, false);
  assert.equal(preview.role, "carrier-manager");
  assert.equal(preview.token_hash, undefined);
  const accepted = await acceptInvite(join(token));
  const user = await session(
    new Request("http://localhost", {
      headers: { cookie: "relay_session=" + accepted.sessionToken },
    }),
  );
  assert.equal(user.email, email);
  assert.equal((await carrierSetup(user.id, id)).can_verify, false);
  await assert.rejects(carrierSetup(user.id, foreign), /NOT_FOUND/);
  const saved = (
    await pool.query("SELECT * FROM onboarding_invites WHERE id=$1", [a.id])
  ).rows[0];
  assert.equal(saved.token_hash, digest(token));
  assert(!JSON.stringify(saved).includes(token));
  const events = await pool.query(
    "SELECT * FROM onboarding_events WHERE carrier_id=$1",
    [id],
  );
  assert(!JSON.stringify(events.rows).includes(token));
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM outbox_events WHERE onboarding_event_id=ANY($1::uuid[])",
        [events.rows.map((e) => e.id)],
      )
    ).rowCount,
    events.rowCount,
  );
  await assert.rejects(
    pool.query("DELETE FROM onboarding_events WHERE carrier_id=$1", [id]),
    /Append-only/,
  );
  await assert.rejects(acceptInvite(join(token)), /INVITE_UNAVAILABLE/);
});
test("pending drivers cannot be assigned; joining activates only that carrier's driver and assigned loads", async () => {
  const id = await create();
  await saveAgreement(admin, id, agreement());
  await pool.query(
    "INSERT INTO memberships VALUES($1,$2,'carrier-manager',NULL)",
    [manager, id],
  );
  const token = secret(),
    input = { key: randomUUID(), token, name: "New driver", email: address() };
  const a = await inviteDriver(manager, id, input);
  assert.deepEqual(await inviteDriver(manager, id, input), a);
  const l = await load(id);
  await assert.rejects(
    mutate(admin, l.id, "assign", { version: 1, driverId: a.driver_id }),
    /DRIVER_CARRIER_MISMATCH/,
  );
  const accepted = await acceptInvite(join(token));
  const user = await session(
    new Request("http://localhost", {
      headers: { cookie: "relay_session=" + accepted.sessionToken },
    }),
  );
  await assert.rejects(detail(user.id, l.id), /NOT_FOUND/);
  await mutate(admin, l.id, "assign", { version: 1, driverId: a.driver_id });
  assert.equal((await detail(user.id, l.id)).id, l.id);
  await assert.rejects(
    inviteDriver(user.id, id, {
      ...input,
      key: randomUUID(),
      token: secret(),
      email: address(),
    }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    inviteDriver(outsider, id, {
      ...input,
      key: randomUUID(),
      token: secret(),
      email: address(),
    }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    inviteDriver(manager, id, { ...input, key: randomUUID(), token: secret() }),
    /DRIVER_ALREADY_ADDED/,
  );
});
test("existing accounts must sign in as the invited email and their password is never overwritten", async () => {
  const id = await create(manager + "@relay.test"),
    token = secret();
  await inviteManager(admin, id, { key: randomUUID(), token });
  assert.equal((await inspectInvite({ token })).account_exists, true);
  await assert.rejects(acceptInvite(join(token)), /INVITE_SIGN_IN_REQUIRED/);
  await assert.rejects(
    acceptInvite(join(token), {
      id: outsider,
      email: outsider + "@relay.test",
    }),
    /INVITE_SIGN_IN_REQUIRED/,
  );
  const result = await acceptInvite(
    { ...join(token), password: "DifferentAttemptPassword" },
    { id: manager, email: manager + "@relay.test" },
  );
  assert.equal(result.role, "carrier-manager");
  assert(
    await verifyPassword(
      password,
      (
        await pool.query("SELECT password_hash FROM users WHERE id=$1", [
          manager,
        ])
      ).rows[0].password_hash,
    ),
  );
});
test("expired, revoked and concurrent invitation uses cannot create duplicate access", async () => {
  const id = await create(),
    old = secret();
  const first = await inviteManager(admin, id, {
    key: randomUUID(),
    token: old,
  });
  await pool.query(
    "UPDATE onboarding_invites SET expires_at=now()-interval '1 second' WHERE id=$1",
    [first.id],
  );
  await assert.rejects(inspectInvite({ token: old }), /INVITE_UNAVAILABLE/);
  const replacement = secret();
  await inviteManager(admin, id, { key: randomUUID(), token: replacement });
  await assert.rejects(acceptInvite(join(old)), /INVITE_UNAVAILABLE/);
  const latest = secret();
  await inviteManager(admin, id, { key: randomUUID(), token: latest });
  await assert.rejects(acceptInvite(join(replacement)), /INVITE_UNAVAILABLE/);
  const outcomes = await Promise.allSettled([
    acceptInvite(join(latest)),
    acceptInvite(join(latest)),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((v) => v.status === "rejected").length, 1);
});
test("public join handlers require same origin and issue secure opaque session cookies", async () => {
  const id = await create(),
    token = secret();
  await inviteManager(admin, id, { key: randomUUID(), token });
  const origin = process.env.APP_ORIGIN || "http://localhost:3000";
  const request = (action: string, body: unknown, o = origin) =>
    new NextRequest(origin + "/api/onboarding/invitations/" + action, {
      method: "POST",
      headers: { origin: o, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await POST(request("accept", join(token), "https://untrusted.example")))
      .status,
    403,
  );
  assert.equal((await POST(request("inspect", { token }))).status, 200);
  assert.equal(
    (await POST(request("accept", { ...join(token), role: "dispatcher" })))
      .status,
    400,
  );
  const response = await POST(request("accept", join(token)));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=strict/i);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).sessionToken, undefined);
});
test("changing the carrier contact revokes unused access links for the previous contact", async () => {
  const id = await create(),
    token = secret();
  await inviteManager(admin, id, { key: randomUUID(), token });
  const original = await carrierSetup(admin, id);
  await saveCompany(admin, id, {
    name: original.carrier.name,
    contact_name: "Replacement contact",
    contact_email: address(),
    version: 1,
    key: randomUUID(),
  });
  await assert.rejects(acceptInvite(join(token)), /INVITE_UNAVAILABLE/);
});
