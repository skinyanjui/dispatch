import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { clientIp, consumeAttempt } from "../../src/lib/auth";
import config from "../../next.config";
import { origin, request } from "./fixtures";

after(() => pool.end());

test("health answers without a session and exposes nothing", async () => {
  const res = await GET(request("health", {}));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("the client address comes from the first forwarded entry", () => {
  const req = (h: Record<string, string>) =>
    new Request(origin + "/api/x", { headers: h });
  assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp(req({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  assert.equal(clientIp(req({})), "unknown");
});

test("a limit allows its quota and then answers 429", async () => {
  const id = "test:" + randomUUID();
  for (let i = 0; i < 3; i++) await consumeAttempt(id, 3);
  await assert.rejects(consumeAttempt(id, 3), { status: 429 });
});

test("one address is throttled across many emails, others are not", async () => {
  const attempt = (ip: string) =>
    POST(
      request("login", {
        json: { email: `nobody-${randomUUID()}@x.test`, password: "wrong-pass-1" },
        headers: { "x-forwarded-for": ip },
      }),
    );
  const ip = "192.0.2." + (1 + Math.floor(Math.random() * 200));
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await attempt(ip)).status;
  assert.equal(last, 429);
  assert.notEqual((await attempt("198.18.0.77")).status, 429);
});

test("pages carry a CSP without framing, plugins or foreign scripts, and HSTS", async () => {
  const rules = await config.headers!();
  const headers = Object.fromEntries(
    rules.flatMap((r) => r.headers.map((h) => [h.key, h.value])),
  );
  const csp = headers["Content-Security-Policy"];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*https?:/);
  assert.match(headers["Strict-Transport-Security"], /max-age=\d{7,}/);
});
