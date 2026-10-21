import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { digest, hashNewPassword, login } from "../../src/lib/auth";
import {
  changePassword,
  completeEmailVerification,
  completeMfaLogin,
  completePasswordReset,
  mfaDisable,
  mfaEnable,
  mfaSetup,
  organization,
  removeTeamMember,
  requestEmailVerification,
  requestPasswordReset,
  saveOrganization,
} from "../../src/lib/account";
import { detail, mutate } from "../../src/lib/loads";
import { openException } from "../../src/lib/exceptions";
import { decrypt } from "../../src/lib/secrets";
import { codeAt, stepAt } from "../../src/lib/totp";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
let t: Awaited<ReturnType<typeof tenant>>;
const password = "fictional-account-password";
before(async () => {
  t = await tenant("Account");
  const hash = await hashNewPassword(password);
  await pool.query("UPDATE users SET password_hash=$2 WHERE id=ANY($1)", [
    [t.dispatcher, t.manager, t.driverUser, t.otherDriverUser],
    hash,
  ]);
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
});
after(() => pool.end());
const emailOf = (id: string) => id + "@relay.test";
/** Reads the newest queued link for a recipient, as the email would carry. */
async function linkFor(user: string, kind: string) {
  const { rows } = await pool.query(
    "SELECT body_ciphertext FROM notifications WHERE recipient_email=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1",
    [emailOf(user), kind],
  );
  const match = /#([a-f0-9]{64})/.exec(decrypt(rows[0].body_ciphertext));
  return match![1];
}

test("password reset: no enumeration, single use, bound to email, ends sessions", async () => {
  assert.deepEqual(
    await requestPasswordReset({
      email: "nobody-" + randomUUID() + "@relay.test",
    }),
    { ok: true },
  );
  await requestPasswordReset(
    { email: emailOf(t.manager) },
    "https://relay.example",
  );
  const first = await linkFor(t.manager, "password_reset");
  await requestPasswordReset({ email: emailOf(t.manager) });
  const second = await linkFor(t.manager, "password_reset");
  // A newer request invalidates the older link.
  await assert.rejects(
    completePasswordReset({ token: first, password: "new-password-123" }),
    {
      code: "TOKEN_UNAVAILABLE",
    },
  );
  // Requests are limited per address, known or not.
  const unknown = "limit-" + randomUUID() + "@relay.test";
  for (let i = 0; i < 3; i++) await requestPasswordReset({ email: unknown });
  await assert.rejects(requestPasswordReset({ email: unknown }), {
    code: "TRY_AGAIN_LATER",
  });
  const session = await sessionFor(t.manager);
  await assert.rejects(
    completePasswordReset({ token: second, password: "short" }),
    {
      name: "ZodError",
    },
  );
  await completePasswordReset({ token: second, password: "new-password-123" });
  assert.equal(
    (
      await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1", [
        digest(session),
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    completePasswordReset({ token: second, password: "another-password-1" }),
    {
      code: "TOKEN_UNAVAILABLE",
    },
  );
  assert.ok("token" in (await login(emailOf(t.manager), "new-password-123")));
  await pool.query("DELETE FROM login_attempts WHERE identity_hash=$1", [
    digest("reset:" + emailOf(t.manager)),
  ]);
  // A link sent to a previous address stops working if the email changes.
  await requestPasswordReset({ email: emailOf(t.manager) });
  const stale = await linkFor(t.manager, "password_reset");
  await pool.query("UPDATE users SET email=$2 WHERE id=$1", [
    t.manager,
    "changed-" + emailOf(t.manager),
  ]);
  await assert.rejects(
    completePasswordReset({ token: stale, password: "new-password-456" }),
    {
      code: "TOKEN_UNAVAILABLE",
    },
  );
  await pool.query("UPDATE users SET email=$2 WHERE id=$1", [
    t.manager,
    emailOf(t.manager),
  ]);
});

test("change password requires the current password and keeps only this session", async () => {
  const current = await sessionFor(t.otherDriverUser);
  const other = await sessionFor(t.otherDriverUser);
  await assert.rejects(
    changePassword(
      t.otherDriverUser,
      { current_password: "wrong", new_password: "changed-password-1" },
      current,
    ),
    { code: "INVALID_CREDENTIALS" },
  );
  await changePassword(
    t.otherDriverUser,
    { current_password: password, new_password: "changed-password-1" },
    current,
  );
  const live = await pool.query(
    "SELECT token_hash FROM sessions WHERE user_id=$1",
    [t.otherDriverUser],
  );
  assert.deepEqual(
    live.rows.map((r) => r.token_hash),
    [digest(current)],
  );
  assert.notEqual(digest(other), digest(current));
});

test("email verification marks the address verified once", async () => {
  assert.deepEqual(await requestEmailVerification(t.driverUser), {
    already_verified: false,
  });
  const token = await linkFor(t.driverUser, "email_verification");
  await completeEmailVerification({ token });
  await assert.rejects(completeEmailVerification({ token }), {
    code: "TOKEN_UNAVAILABLE",
  });
  assert.deepEqual(await requestEmailVerification(t.driverUser), {
    already_verified: true,
  });
});

test("MFA: enrollment, login challenge, replay protection, recovery codes, attempts and disable", async () => {
  const key = process.env.RELAY_DATA_KEY;
  delete process.env.RELAY_DATA_KEY;
  await assert.rejects(mfaSetup(t.driverUser), { code: "MFA_UNAVAILABLE" });
  process.env.RELAY_DATA_KEY = key;
  const { secret, otpauth_uri } = await mfaSetup(t.driverUser);
  assert.match(otpauth_uri, /^otpauth:\/\/totp\/Relay%3A.*secret=/);
  const stored = await pool.query(
    "SELECT mfa_secret_ciphertext FROM users WHERE id=$1",
    [t.driverUser],
  );
  assert.ok(!stored.rows[0].mfa_secret_ciphertext.includes(secret));
  await assert.rejects(
    mfaEnable(t.driverUser, {
      code:
        "000000" === codeAt(secret, stepAt(Date.now())) ? "111111" : "000000",
    }),
    {
      code: "INVALID_MFA_CODE",
    },
  );
  const now = stepAt(Date.now());
  const { recovery_codes } = await mfaEnable(t.driverUser, {
    code: codeAt(secret, now),
  });
  assert.equal(recovery_codes.length, 10);
  // Password alone no longer creates a session.
  const http = await POST(
    request("login", { json: { email: emailOf(t.driverUser), password } }),
  );
  const body = await http.json();
  assert.equal(body.mfa_required, true);
  assert.equal(http.headers.get("set-cookie"), null);
  // The code already used for enrollment cannot be replayed.
  await assert.rejects(
    completeMfaLogin({ challenge: body.challenge, code: codeAt(secret, now) }),
    {
      code: "INVALID_MFA_CODE",
    },
  );
  const session = await completeMfaLogin({
    challenge: body.challenge,
    code: codeAt(secret, now + 1),
  });
  assert.equal(session.token.length, 64);
  assert.equal(session.remember, false);
  await assert.rejects(
    completeMfaLogin({
      challenge: body.challenge,
      code: codeAt(secret, now + 1),
    }),
    {
      code: "MFA_CHALLENGE_EXPIRED",
    },
  );
  // Recovery codes work once.
  const challenge = (await login(emailOf(t.driverUser), password)) as {
    mfa_challenge: string;
  };
  await completeMfaLogin({
    challenge: challenge.mfa_challenge,
    code: recovery_codes[0].toUpperCase(),
  });
  const again = (await login(emailOf(t.driverUser), password)) as {
    mfa_challenge: string;
  };
  await assert.rejects(
    completeMfaLogin({
      challenge: again.mfa_challenge,
      code: recovery_codes[0],
    }),
    {
      code: "INVALID_MFA_CODE",
    },
  );
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      completeMfaLogin({ challenge: again.mfa_challenge, code: "bad" }),
    );
  await assert.rejects(
    completeMfaLogin({
      challenge: again.mfa_challenge,
      code: recovery_codes[1],
    }),
    {
      code: "TRY_AGAIN_LATER",
    },
  );
  await assert.rejects(
    mfaDisable(t.driverUser, { password: "wrong", code: recovery_codes[1] }),
    {
      code: "INVALID_CREDENTIALS",
    },
  );
  await mfaDisable(t.driverUser, { password, code: recovery_codes[1] });
  assert.ok("token" in (await login(emailOf(t.driverUser), password)));
});

test("organization profile is admin-only with optimistic versions", async () => {
  const view = await organization(t.dispatcher, t.organization);
  assert.equal(view.role, "owner");
  assert.ok(
    view.team.some((p: { user_id: string }) => p.user_id === t.driverUser),
  );
  await assert.rejects(organization(t.manager, t.organization), {
    code: "NOT_FOUND",
  });
  const input = {
    version: 0,
    name: "Account QA Dispatch",
    legal_name: "Account QA Dispatch LLC",
    billing_email: "billing@relay.test",
    phone: "",
    address: "1 Fictional Way",
    timezone: "America/Denver",
  };
  await saveOrganization(t.dispatcher, t.organization, input);
  await assert.rejects(saveOrganization(t.dispatcher, t.organization, input), {
    code: "VERSION_CONFLICT",
  });
  await assert.rejects(
    saveOrganization(t.dispatcher, t.organization, {
      ...input,
      version: 1,
      timezone: "Mars/Base",
    }),
    {
      name: "ZodError",
    },
  );
  await assert.rejects(
    saveOrganization(t.manager, t.organization, { ...input, version: 1 }),
    {
      code: "NOT_FOUND",
    },
  );
  assert.equal(
    (await organization(t.dispatcher, t.organization)).timezone,
    "America/Denver",
  );
});

test("team removal rules, access loss, exception release and isolation", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: 1,
    driverId: t.otherDriver,
  });
  const reason = { reason: "Left the company" };
  await assert.rejects(
    removeTeamMember(t.manager, t.carrier, {
      driver_id: t.otherDriver,
      ...reason,
    }),
    {
      code: "DRIVER_HAS_ACTIVE_LOADS",
    },
  );
  await mutate(t.dispatcher, load.id, "assign", {
    version: 2,
    driverId: t.driver,
  });
  await assert.rejects(
    removeTeamMember(t.manager, t.carrier, {
      user_id: t.dispatcher,
      ...reason,
    }),
    {
      code: "ROLE_NOT_PERMITTED",
    },
  );
  await assert.rejects(
    removeTeamMember(t.manager, t.carrier, { user_id: t.manager, ...reason }),
    {
      code: "CANNOT_REMOVE_SELF",
    },
  );
  await assert.rejects(
    removeTeamMember(t.driverUser, t.carrier, {
      driver_id: t.otherDriver,
      ...reason,
    }),
    {
      code: "NOT_FOUND",
    },
  );
  await assert.rejects(
    removeTeamMember(t.foreignManager, t.carrier, {
      driver_id: t.otherDriver,
      ...reason,
    }),
    {
      code: "NOT_FOUND",
    },
  );
  const otherSession = await sessionFor(t.otherDriverUser);
  await removeTeamMember(t.manager, t.carrier, {
    driver_id: t.otherDriver,
    ...reason,
  });
  assert.equal(
    (
      await pool.query("SELECT onboarding_status FROM drivers WHERE id=$1", [
        t.otherDriver,
      ])
    ).rows[0].onboarding_status,
    "removed",
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1", [
        digest(otherSession),
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    mutate(t.dispatcher, load.id, "assign", {
      version: 3,
      driverId: t.otherDriver,
    }),
    {
      code: "DRIVER_CARRIER_MISMATCH",
    },
  );
  // Removing a manager returns their open exceptions to the queue.
  const owned = await openException(t.dispatcher, load.id, {
    type: "delay",
    severity: "medium",
    summary: "Owned by manager",
    owner_id: t.manager,
    idempotency_key: randomUUID(),
  });
  await assert.rejects(
    removeTeamMember(t.dispatcher, t.carrier, {
      user_id: t.dispatcher,
      ...reason,
    }),
    {
      code: "CANNOT_REMOVE_SELF",
    },
  );
  await removeTeamMember(t.dispatcher, t.carrier, {
    user_id: t.manager,
    ...reason,
  });
  await assert.rejects(detail(t.manager, load.id), { code: "NOT_FOUND" });
  const exception = await pool.query(
    "SELECT owner_id,version FROM load_exceptions WHERE id=$1",
    [owned.id],
  );
  assert.equal(exception.rows[0].owner_id, null);
  assert.equal(exception.rows[0].version, 2);
  // The last dispatcher of a carrier stays.
  const second = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Second dispatcher')",
    [second, emailOf(second)],
  );
  await pool.query("INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)", [
    second,
    t.foreign,
  ]);
  await removeTeamMember(t.dispatcher, t.foreign, {
    user_id: second,
    ...reason,
  });
  const lone = randomUUID();
  await pool.query("INSERT INTO carriers VALUES($1,$2,'Lone carrier')", [
    lone,
    t.organization,
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)", [
    second,
    lone,
  ]);
  // Organization owner (no membership on this carrier) may manage it, but
  // the only dispatcher cannot be removed.
  await assert.rejects(
    removeTeamMember(t.dispatcher, lone, { user_id: second, ...reason }),
    {
      code: "LAST_DISPATCHER",
    },
  );
  const removals = await pool.query(
    "SELECT count(*)::int n FROM membership_removals WHERE carrier_id=$1",
    [t.carrier],
  );
  assert.equal(removals.rows[0].n, 2);
  // HTTP path is session-bound and origin-checked.
  const token = await sessionFor(t.foreignManager);
  const denied = await POST(
    request("carriers/" + t.carrier + "/team/remove", {
      token,
      json: { driver_id: t.driver, ...reason },
    }),
  );
  assert.equal(denied.status, 404);
});
