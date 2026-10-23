import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { digest, hashNewPassword, login } from "../../src/lib/auth";
import { completeMfaLogin, mfaEnable, mfaSetup } from "../../src/lib/account";
import { appOrigin } from "../../src/lib/notifications";
import { codeAt, stepAt } from "../../src/lib/totp";
import { origin, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
const password = "fictional-security-password";
let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Security");
  await pool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
    t.manager,
    await hashNewPassword(password),
  ]);
});
after(() => pool.end());

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  const set = (o: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(o))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  set(values);
  try {
    fn();
  } finally {
    set(saved);
  }
}

test("emailed links never take their origin from the request in production", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ORIGIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: "relay.example",
      VERCEL_URL: undefined,
    },
    () => {
      // A forged Host/Origin pair must not reach a reset or invitation link.
      assert.equal(appOrigin("https://evil.example"), "https://relay.example");
    },
  );
  withEnv({ NODE_ENV: "production", APP_ORIGIN: "https://app.example" }, () =>
    assert.equal(appOrigin("https://evil.example"), "https://app.example"),
  );
  withEnv({ NODE_ENV: "development", APP_ORIGIN: undefined }, () =>
    assert.equal(appOrigin("http://localhost:4000"), "http://localhost:4000"),
  );
});

test("second-factor guesses are budgeted per address and per account, and a reset lifts the ceiling", async () => {
  const { secret } = await mfaSetup(t.manager);
  await mfaEnable(t.manager, { code: codeAt(secret, stepAt(Date.now())) });
  const email = (
    await pool.query("SELECT email FROM users WHERE id=$1", [t.manager])
  ).rows[0].email as string;
  const from = (ip: string) =>
    new Request(origin + "/api/login/mfa", {
      headers: { "x-forwarded-for": ip },
    });
  const guess = async (ip: string) => {
    // Each correct password issues a fresh challenge with five more guesses.
    const c = (await login(email, password)) as { mfa_challenge: string };
    return completeMfaLogin(
      { challenge: c.mfa_challenge, code: "000000" },
      from(ip),
    );
  };
  for (let i = 0; i < 10; i++)
    await assert.rejects(guess("192.0.2.10"), { code: "INVALID_MFA_CODE" });
  await assert.rejects(guess("192.0.2.10"), { code: "TRY_AGAIN_LATER" });
  // The attacker's address being spent does not lock out another address.
  await assert.rejects(guess("192.0.2.11"), { code: "INVALID_MFA_CODE" });
  // Spread over many addresses, the account-wide ceiling still stops guessing.
  for (let i = 0; i < 19; i++)
    await assert.rejects(guess("198.51.100." + (20 + i)), {
      code: "INVALID_MFA_CODE",
    });
  await assert.rejects(guess("203.0.113.99"), { code: "TRY_AGAIN_LATER" });
  // Resetting the password by email lifts the ceiling for the owner.
  await pool.query("DELETE FROM login_attempts WHERE identity_hash=$1", [
    digest("mfa-login:" + t.manager),
  ]);
  await assert.rejects(guess("203.0.113.99"), { code: "INVALID_MFA_CODE" });
});

test("unauthenticated mail and token endpoints are limited per address", async () => {
  const attempt = (ip: string) =>
    POST(
      request("password-reset/request", {
        json: { email: `nobody-${randomUUID()}@x.test` },
        headers: { "x-forwarded-for": ip },
      }),
    );
  const ip = "198.51.100." + (1 + Math.floor(Math.random() * 200));
  let last = 0;
  for (let i = 0; i < 41; i++) last = (await attempt(ip)).status;
  assert.equal(last, 429);
  assert.notEqual((await attempt("203.0.113.250")).status, 429);
});

test("required two-step verification blocks everything but Account until it is on", async () => {
  process.env.RELAY_REQUIRE_MFA = "true";
  try {
    const dispatcher = await sessionFor(t.dispatcher);
    const driver = await sessionFor(t.driverUser);
    const blocked = await GET(request("loads", { token: dispatcher }));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, "MFA_REQUIRED");
    const me = await GET(request("me", { token: dispatcher }));
    assert.equal((await me.json()).mfa_required, true);
    assert.equal(
      (await GET(request("account", { token: dispatcher }))).status,
      200,
    );
    // Drivers are not required to enroll.
    assert.notEqual(
      (await GET(request("loads", { token: driver }))).status,
      403,
    );
    // Without a key to store second factors, nobody is locked out.
    const key = process.env.RELAY_DATA_KEY;
    delete process.env.RELAY_DATA_KEY;
    assert.notEqual(
      (await GET(request("loads", { token: dispatcher }))).status,
      403,
    );
    process.env.RELAY_DATA_KEY = key;
    const { secret } = await mfaSetup(t.dispatcher);
    await mfaEnable(t.dispatcher, { code: codeAt(secret, stepAt(Date.now())) });
    assert.equal(
      (await GET(request("loads", { token: dispatcher }))).status,
      200,
    );
  } finally {
    delete process.env.RELAY_REQUIRE_MFA;
  }
});

test("secrets sealed with the previous key stay readable and can be re-sealed", async () => {
  const { encrypt, decrypt, needsReseal } =
    await import("../../src/lib/secrets");
  const saved = {
    key: process.env.RELAY_DATA_KEY,
    previous: process.env.RELAY_DATA_KEY_PREVIOUS,
  };
  try {
    const oldKey = randomBytes(32).toString("base64");
    process.env.RELAY_DATA_KEY = oldKey;
    delete process.env.RELAY_DATA_KEY_PREVIOUS;
    const sealed = encrypt("fictional secret")!;
    process.env.RELAY_DATA_KEY = randomBytes(32).toString("base64");
    assert.throws(() => decrypt(sealed));
    process.env.RELAY_DATA_KEY_PREVIOUS = oldKey;
    assert.equal(decrypt(sealed), "fictional secret");
    assert.equal(needsReseal(sealed), true);
    const fresh = encrypt(decrypt(sealed))!;
    assert.equal(needsReseal(fresh), false);
    delete process.env.RELAY_DATA_KEY_PREVIOUS;
    assert.equal(decrypt(fresh), "fictional secret");
  } finally {
    if (saved.key) process.env.RELAY_DATA_KEY = saved.key;
    if (saved.previous) process.env.RELAY_DATA_KEY_PREVIOUS = saved.previous;
    else delete process.env.RELAY_DATA_KEY_PREVIOUS;
  }
});
