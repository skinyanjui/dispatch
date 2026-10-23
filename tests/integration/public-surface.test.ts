import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { configWarnings } from "../../src/lib/config-check";
import { request } from "./fixtures";

after(() => pool.end());

// Every API family is behind sign-in unless it is listed here on purpose.
// A new public family must be added to this list in review.
const publicFamilies = new Set([
  "health",
  "login",
  "logout",
  "password-reset",
  "access-requests",
  "account", // only verify-email/complete is public; the rest is checked below
  "onboarding", // only invitations/* is public
  "webhooks",
  "jobs", // bearer secret, not a session
  "auth",
]);
const source = readFileSync("src/app/api/[...path]/route.ts", "utf8");
const families = [
  ...new Set(
    [...source.matchAll(/path\[0\] === "([a-z-]+)"/g)].map((m) => m[1]),
  ),
];

test("the router has families to check", () => assert.ok(families.length > 15));

test("every non-public API family refuses a caller with no session", async () => {
  for (const family of families.filter((f) => !publicFamilies.has(f))) {
    for (const method of [GET, POST]) {
      const res = await method(
        request(family, method === POST ? { json: {} } : {}),
      );
      assert.equal(res.status, 401, `${family} answered ${res.status}`);
    }
  }
});

test("account and onboarding routes other than the public ones need sign-in", async () => {
  for (const path of ["account", "account/profile", "onboarding/carriers"]) {
    assert.equal((await GET(request(path, {}))).status, 401, path);
  }
  assert.equal(
    (await POST(request("account/mfa/enable", { json: {} }))).status,
    401,
  );
});

test("the scheduled job and status endpoints do not answer anonymous callers", async () => {
  assert.equal(
    (await GET(request("jobs/notifications", {}))).status === 200,
    false,
  );
  assert.equal((await GET(request("jobs/status", {}))).status, 401);
});

test("insecure production settings are named", () => {
  assert.equal(configWarnings({}).length, 4);
  const ok = {
    RELAY_DATA_KEY: Buffer.alloc(32, 1).toString("base64"),
    CRON_SECRET: "x".repeat(16),
    APP_ORIGIN: "https://relay.example",
    RELAY_REQUIRE_MALWARE_SCAN: "true",
  };
  assert.deepEqual(configWarnings(ok), []);
});
