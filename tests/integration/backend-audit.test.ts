import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { consumeAttempt, digest } from "../../src/lib/auth";
import { pruneExpiredCredentials } from "../../src/lib/account";
import { createLoad } from "../../src/lib/loads";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("BackendAudit");
});
after(() => pool.end());

test("a person sees their own sessions, ends one or all others, and never another person's", async () => {
  const mine = await sessionFor(t.dispatcher);
  const other = await sessionFor(t.dispatcher);
  const theirs = await sessionFor(t.manager);
  const listed = await (
    await GET(request("account/sessions", { token: mine }))
  ).json();
  assert.equal(listed.sessions.length, 2);
  assert.equal(
    listed.sessions.filter((s: { current: boolean }) => s.current).length,
    1,
  );
  const otherId = (
    await pool.query("SELECT id FROM sessions WHERE token_hash=$1", [
      digest(other),
    ])
  ).rows[0].id as string;
  const theirId = (
    await pool.query("SELECT id FROM sessions WHERE token_hash=$1", [
      digest(theirs),
    ])
  ).rows[0].id as string;
  // Someone else's session id is not found, and still works afterwards.
  assert.equal(
    (
      await POST(
        request(`account/sessions/${theirId}/revoke`, {
          token: mine,
          json: {},
        }),
      )
    ).status,
    404,
  );
  assert.equal((await GET(request("account", { token: theirs }))).status, 200);
  // The current session cannot be ended by id (use sign out).
  const currentId = listed.sessions.find(
    (s: { current: boolean }) => s.current,
  ).id;
  assert.equal(
    (
      await POST(
        request(`account/sessions/${currentId}/revoke`, {
          token: mine,
          json: {},
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await POST(
        request(`account/sessions/${otherId}/revoke`, {
          token: mine,
          json: {},
        }),
      )
    ).status,
    200,
  );
  assert.equal((await GET(request("account", { token: other }))).status, 401);
  const extra = await sessionFor(t.dispatcher);
  const ended = await (
    await POST(
      request("account/sessions/revoke-others", { token: mine, json: {} }),
    )
  ).json();
  assert.equal(ended.ended, 1);
  assert.equal((await GET(request("account", { token: extra }))).status, 401);
  assert.equal((await GET(request("account", { token: mine }))).status, 200);
  assert.equal((await GET(request("account", { token: theirs }))).status, 200);
  const audited = await pool.query(
    "SELECT action FROM audit_logs WHERE actor_id=$1 AND action LIKE 'session.revoked%'",
    [t.dispatcher],
  );
  assert.ok(audited.rowCount! >= 2);
});

test("expired credentials are pruned and live ones are kept", async () => {
  const live = await sessionFor(t.driverUser);
  const dead = await sessionFor(t.driverUser);
  await pool.query(
    "UPDATE sessions SET expires_at=now()-interval '8 days' WHERE token_hash=$1",
    [digest(dead)],
  );
  const recentlyExpired = await sessionFor(t.driverUser);
  await pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 day' WHERE token_hash=$1",
    [digest(recentlyExpired)],
  );
  const result = await pruneExpiredCredentials();
  assert.ok(result.sessions >= 1);
  const left = await pool.query(
    "SELECT token_hash FROM sessions WHERE token_hash=ANY($1)",
    [[digest(live), digest(dead), digest(recentlyExpired)]],
  );
  assert.deepEqual(
    left.rows.map((r) => r.token_hash).sort(),
    [digest(live), digest(recentlyExpired)].sort(),
  );
});

test("the rate limiter is exact under concurrent callers", async () => {
  const id = "concurrent:" + randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 25 }, () => consumeAttempt(id, 10)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
});

test("lookups the app depends on are indexed", async () => {
  const wanted = [
    "sessions_by_user",
    "memberships_by_carrier",
    "organization_members_by_user",
    "drivers_by_carrier",
    "notifications_by_recipient",
    "audit_by_actor",
  ];
  const { rows } = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE indexname=ANY($1)",
    [wanted],
  );
  assert.deepEqual(rows.map((r) => r.indexname).sort(), wanted.sort());
});

test("the same load created twice at once, or with a taken reference, yields one record", async () => {
  const key = randomUUID();
  const start = Date.now() + 48 * 3600000;
  const input = {
    carrierId: t.carrier,
    reference: "CONC-" + randomUUID().slice(0, 8),
    source: "Fictional integration QA",
    amountMinor: 100000,
    stops: [
      {
        kind: "pickup",
        address: "Chicago, IL",
        timezone: "America/Chicago",
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(start + 3600000).toISOString(),
      },
      {
        kind: "delivery",
        address: "Nashville, TN",
        timezone: "America/Chicago",
        windowStart: new Date(start + 86400000).toISOString(),
        windowEnd: new Date(start + 90000000).toISOString(),
      },
    ],
  };
  const same = await Promise.allSettled(
    Array.from({ length: 6 }, () => createLoad(t.dispatcher, input, key)),
  );
  assert.ok(
    same.every((r) => r.status === "fulfilled"),
    "a retry is not an error",
  );
  const ids = new Set(
    same.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id),
  );
  assert.equal(ids.size, 1);
  // Different keys, same reference: exactly one wins, the rest are refused cleanly.
  const racing = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      createLoad(
        t.dispatcher,
        { ...input, reference: "RACE-" + key.slice(0, 8) },
        randomUUID(),
      ),
    ),
  );
  assert.equal(racing.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of racing)
    if (r.status === "rejected") assert.equal(r.reason?.code, "23505"); // the router answers 409 DUPLICATE_REFERENCE
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM loads WHERE reference=$1 AND carrier_id=$2",
        ["RACE-" + key.slice(0, 8), t.carrier],
      )
    ).rowCount,
    1,
  );
});
