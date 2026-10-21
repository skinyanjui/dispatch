import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { digest, hashNewPassword, login } from "../../src/lib/auth";
import { mfaEnable, mfaSetup } from "../../src/lib/account";
import { codeAt, stepAt } from "../../src/lib/totp";
import { request, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
const password = "fictional-remember-password";
let t: Awaited<ReturnType<typeof tenant>>;
const emailOf = (id: string) => id + "@relay.test";
before(async () => {
  t = await tenant("Remember");
  for (const user of [t.dispatcher, t.manager])
    await pool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
      user,
      await hashNewPassword(password),
    ]);
});
after(() => pool.end());

const ttlHours = async (token: string) =>
  Number(
    (
      await pool.query(
        "SELECT extract(epoch FROM expires_at-now())/3600 AS h,remember FROM sessions WHERE token_hash=$1",
        [digest(token)],
      )
    ).rows[0].h,
  );
const ttlOf = async (token: string) =>
  (
    await pool.query("SELECT remember FROM sessions WHERE token_hash=$1", [
      digest(token),
    ])
  ).rows[0].remember as boolean;

test("a normal sign-in lasts 12 hours; keep-me-signed-in lasts 30 days", async () => {
  const short = await login(emailOf(t.dispatcher), password);
  assert.ok("token" in short);
  assert.equal(short.remember, false);
  const hours = await ttlHours(short.token);
  assert.ok(hours > 11.9 && hours <= 12, String(hours));
  assert.equal(await ttlOf(short.token), false);
  const long = await login(emailOf(t.dispatcher), password, true);
  assert.ok("token" in long);
  assert.equal(long.remember, true);
  const days = (await ttlHours(long.token)) / 24;
  assert.ok(days > 29.9 && days <= 30, String(days));
  assert.equal(await ttlOf(long.token), true);
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE actor_id=$1 AND action LIKE 'session.created%' ORDER BY created_at",
    [t.dispatcher],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ["session.created", "session.created.remembered"],
  );
});

test("HTTP: the cookie ends with the browser unless the person chose to stay signed in", async () => {
  const cookie = async (remember?: boolean) => {
    const res = await POST(
      request("login", {
        json: {
          email: emailOf(t.manager),
          password,
          ...(remember === undefined ? {} : { remember }),
        },
      }),
    );
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie") ?? "";
  };
  const session = await cookie();
  assert.match(session, /relay_session=/);
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=strict/i);
  assert.doesNotMatch(session, /Max-Age|Expires/i);
  assert.doesNotMatch(await cookie(false), /Max-Age|Expires/i);
  assert.match(await cookie(true), /Max-Age=2592000/i);
  const bad = await POST(
    request("login", {
      json: { email: emailOf(t.manager), password, remember: "yes" },
    }),
  );
  assert.equal(bad.status, 400);
});

test("the choice carries through the second factor", async () => {
  const { secret } = await mfaSetup(t.dispatcher);
  const { recovery_codes } = await mfaEnable(t.dispatcher, {
    code: codeAt(secret, stepAt(Date.now())),
  });
  const start = await POST(
    request("login", {
      json: { email: emailOf(t.dispatcher), password, remember: true },
    }),
  );
  const body = await start.json();
  assert.equal(body.mfa_required, true);
  assert.equal(start.headers.get("set-cookie"), null);
  const pending = await pool.query(
    "SELECT remember FROM mfa_challenges WHERE token_hash=$1",
    [digest(body.challenge)],
  );
  assert.equal(pending.rows[0].remember, true);
  const done = await POST(
    request("login/mfa", {
      json: {
        challenge: body.challenge,
        code: codeAt(secret, stepAt(Date.now()) + 1),
      },
    }),
  );
  assert.equal(done.status, 200);
  assert.match(done.headers.get("set-cookie") ?? "", /Max-Age=2592000/i);
  // Without the choice, the second factor (a recovery code here) gives a
  // session cookie.
  const again = await (
    await POST(
      request("login", { json: { email: emailOf(t.dispatcher), password } }),
    )
  ).json();
  const plain = await POST(
    request("login/mfa", {
      json: {
        challenge: again.challenge,
        code: recovery_codes[0],
      },
    }),
  );
  assert.equal(plain.status, 200);
  assert.doesNotMatch(plain.headers.get("set-cookie") ?? "", /Max-Age/i);
});
