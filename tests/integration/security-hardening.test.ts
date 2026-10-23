import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { hashNewPassword, login } from "../../src/lib/auth";
import { completeMfaLogin, mfaEnable, mfaSetup } from "../../src/lib/account";
import { appOrigin } from "../../src/lib/notifications";
import { codeAt, stepAt } from "../../src/lib/totp";
import { request, tenant } from "./fixtures";

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

test("second-factor guesses are budgeted per person, not per challenge", async () => {
  const { secret } = await mfaSetup(t.manager);
  await mfaEnable(t.manager, { code: codeAt(secret, stepAt(Date.now())) });
  const email = (
    await pool.query("SELECT email FROM users WHERE id=$1", [t.manager])
  ).rows[0].email as string;
  // Each correct password issues a fresh challenge with five more guesses.
  for (let i = 0; i < 10; i++) {
    const challenge = (await login(email, password)) as {
      mfa_challenge: string;
    };
    await assert.rejects(
      completeMfaLogin({ challenge: challenge.mfa_challenge, code: "000000" }),
      { code: "INVALID_MFA_CODE" },
    );
  }
  const fresh = (await login(email, password)) as { mfa_challenge: string };
  await assert.rejects(
    completeMfaLogin({ challenge: fresh.mfa_challenge, code: "000000" }),
    { code: "TRY_AGAIN_LATER" },
  );
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
