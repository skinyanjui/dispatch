import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  authorityAttention,
  authorityFailing,
  authorityStatus,
  checkAuthority,
  configuredProvider,
  fixtureProvider,
  fmcsaProvider,
  parseFmcsa,
  runAuthorityChecks,
} from "../../src/lib/authority";
import {
  deriveAuthority,
  sameName,
  type AuthorityCheck,
} from "../../src/lib/authority-state";
import { collectAlerts } from "../../src/lib/alerts";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  // Most tests look a carrier up several times in a row; one test sets a cooldown.
  process.env.RELAY_AUTHORITY_COOLDOWN_SECONDS = "0";
  t = await tenant("Authority");
});
after(() => pool.end());

const setDot = (carrier: string, usdot: string, step = "complete") =>
  pool.query(
    `INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone,usdot,step)
     VALUES($1,'Casey','casey@carrier.test','',$2,$3)
     ON CONFLICT(carrier_id) DO UPDATE SET usdot=$2,step=$3`,
    [carrier, usdot, step],
  );
const check = (carrier = t.carrier, user = t.dispatcher) =>
  checkAuthority(user, { carrier_id: carrier, key: randomUUID() });
const ok = (over: Partial<AuthorityCheck> = {}): AuthorityCheck => ({
  outcome: "ok",
  source: "fixture",
  legal_name: "Blue Ridge Transport LLC",
  authority_status: "active",
  allowed_to_operate: true,
  out_of_service: false,
  insurance_on_file: true,
  observed_at: new Date().toISOString(),
  ...over,
});

test("names match across punctuation and company suffixes, not across businesses", () => {
  const same: [string, string][] = [
    ["BLUE RIDGE TRANSPORT, L.L.C.", "Blue Ridge Transport"],
    ["Blue Ridge Transport Inc", "Blue Ridge Transport LLC"],
    ["Smith & Sons Trucking Co.", "Smith and Sons Trucking"],
    ["Blue Ridge Transport Holdings of Texas", "Blue Ridge Transport"],
    ["Ridge Trucking", "Blue Ridge Transport"],
  ];
  for (const [a, b] of same) assert.equal(sameName(a, b), true, a + " / " + b);
  const different: [string, string][] = [
    ["Unrelated Freight Holdings", "Blue Ridge Transport"],
    ["Transport LLC", "Blue Ridge Transport"], // says nothing about which company
    ["Freight Lines Inc", "Blue Ridge Transport"],
    ["A", "Blue Ridge Transport"], // one letter matches nothing
    ["Blue Transport", "Blue Ridge Transport"], // one short word is not enough
    ["Red Ridge Transport", "Blue Ridge Transport"],
    ["", "Blue Ridge Transport"],
    ["Blue Ridge Transport", ""],
  ];
  for (const [a, b] of different)
    assert.equal(sameName(a, b), false, a + " / " + b);
});

test("each finding raises its own flag; trouble reaching the registry never hides the last good result", () => {
  const name = "Blue Ridge Transport";
  assert.equal(deriveAuthority(null, null, name).state, "unchecked");
  assert.equal(deriveAuthority(ok(), ok(), name).state, "clear");
  const cases: [Partial<AuthorityCheck>, string][] = [
    [{ allowed_to_operate: false }, "not_allowed_to_operate"],
    [{ authority_status: "inactive" }, "authority_inactive"],
    [{ authority_status: "revoked" }, "authority_revoked"],
    [{ out_of_service: true }, "out_of_service"],
    [{ insurance_on_file: false }, "no_insurance_on_file"],
    [{ legal_name: "Somebody Else LLC" }, "name_differs"],
  ];
  for (const [over, flag] of cases) {
    const d = deriveAuthority(ok(over), ok(over), name);
    assert.equal(d.state, "attention", flag);
    assert.ok(d.flags.includes(flag as never), flag);
  }
  const missing = deriveAuthority(
    { ...ok(), outcome: "not_found" },
    null,
    name,
  );
  assert.deepEqual(
    [missing.state, missing.flags],
    ["attention", ["dot_not_found"]],
  );
  // A failed lookup after a good one: still the good one's facts, marked unverified.
  const failed = deriveAuthority({ ...ok(), outcome: "error" }, ok(), name);
  assert.deepEqual(
    [failed.state, failed.flags],
    ["unverified", ["lookup_failed"]],
  );
  // ...but a known problem stays a problem.
  const bad = ok({ out_of_service: true });
  assert.equal(
    deriveAuthority({ ...ok(), outcome: "error" }, bad, name).state,
    "attention",
  );
  // Old results are stale, never clear.
  const old = ok({
    observed_at: new Date(Date.now() - 100 * 3600000).toISOString(),
  });
  const stale = deriveAuthority(old, old, name);
  assert.deepEqual([stale.state, stale.flags], ["unverified", ["stale"]]);
  assert.equal(stale.age_hours, 100);
});

test("the fixture provider shows every state from the last digit, and says it is fixture", async () => {
  assert.equal((await fixtureProvider.lookup("1000001", "X")).found, true);
  assert.equal((await fixtureProvider.lookup("1000009", "X")).found, false);
  await setDot(t.carrier, "1000001");
  const first = await check();
  assert.equal(first.state, "clear");
  assert.equal(first.source, "fixture");
  for (const [dot, flag] of [
    ["1000009", "dot_not_found"],
    ["1000008", "authority_revoked"],
    ["1000007", "no_insurance_on_file"],
    ["1000006", "name_differs"],
    ["1000004", "out_of_service"],
  ] as const) {
    await setDot(t.carrier, dot);
    const s = await check();
    assert.equal(s.state, "attention", dot);
    assert.ok(s.flags.includes(flag), dot);
  }
  await setDot(t.carrier, "1000001");
  assert.equal((await check()).state, "clear");
});

test("a check needs a USDOT number, is idempotent, is isolated by carrier and is append-only", async () => {
  await pool.query("DELETE FROM carrier_profiles WHERE carrier_id=$1", [
    t.foreign,
  ]);
  await assert.rejects(check(t.foreign), { code: "USDOT_REQUIRED" });
  await setDot(t.carrier, "2000001");
  const key = randomUUID();
  const count = async () =>
    (
      await pool.query(
        "SELECT count(*)::int n FROM carrier_authority_checks WHERE carrier_id=$1",
        [t.carrier],
      )
    ).rows[0].n;
  const before = await count();
  await checkAuthority(t.dispatcher, { carrier_id: t.carrier, key });
  await checkAuthority(t.dispatcher, { carrier_id: t.carrier, key });
  assert.equal((await count()) - before, 1);
  await setDot(t.foreign, "2000002");
  await assert.rejects(
    checkAuthority(t.dispatcher, { carrier_id: t.foreign, key }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  // Managers may check their own carrier; other carriers' people and drivers may not.
  assert.equal((await authorityStatus(t.manager, t.carrier)).state, "clear");
  for (const user of [t.foreignManager, t.driverUser]) {
    await assert.rejects(authorityStatus(user, t.carrier), {
      code: "NOT_FOUND",
    });
    await assert.rejects(check(t.carrier, user), { code: "NOT_FOUND" });
  }
  await assert.rejects(
    pool.query(
      "UPDATE carrier_authority_checks SET legal_name='x' WHERE carrier_id=$1",
      [t.carrier],
    ),
    /Append-only/,
  );
});

test("HTTP: read and check are for people of the carrier only", async () => {
  await setDot(t.carrier, "3000001");
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
  const read = await call("POST", "authority/check", t.dispatcher, {
    carrier_id: t.carrier,
    key: randomUUID(),
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.state, "clear");
  assert.equal(read.body.usdot, "3000001");
  assert.equal(
    (await call("GET", "authority?carrier_id=" + t.carrier, t.manager)).status,
    200,
  );
  for (const user of [t.driverUser, t.foreignManager])
    assert.equal(
      (await call("GET", "authority?carrier_id=" + t.carrier, user)).status,
      404,
    );
  assert.equal(
    (
      await call("POST", "authority/check", t.dispatcher, {
        carrier_id: t.carrier,
      })
    ).status,
    400,
  );
});

test("the FMCSA parser maps the service's fields and never guesses at an unknown shape", async () => {
  const at = "2026-10-24T12:00:00.000Z";
  const found = parseFmcsa(
    {
      content: {
        carrier: {
          legalName: "BLUE RIDGE TRANSPORT LLC",
          allowedToOperate: "Y",
          outOfService: "N",
          commonAuthorityStatus: "A",
          bipdInsuranceOnFile: "750",
        },
      },
    },
    at,
  );
  assert.deepEqual(found, {
    found: true,
    legal_name: "BLUE RIDGE TRANSPORT LLC",
    authority_status: "active",
    allowed_to_operate: true,
    out_of_service: false,
    insurance_on_file: true,
    observed_at: at,
  });
  const lapsed = parseFmcsa(
    {
      content: {
        carrier: {
          allowedToOperate: "N",
          commonAuthorityStatus: "N",
          bipdInsuranceOnFile: "0",
        },
      },
    },
    at,
  );
  assert.ok(
    lapsed.found &&
      lapsed.authority_status === "revoked" &&
      lapsed.insurance_on_file === false &&
      lapsed.allowed_to_operate === false,
  );
  assert.equal(parseFmcsa({ nothing: true }, at).found, false);
  const fake = (status: number, body: unknown = {}) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  assert.equal(
    (await fmcsaProvider("k", fake(404)).lookup("1", "x")).found,
    false,
  );
  await assert.rejects(
    fmcsaProvider("k", fake(503)).lookup("1", "x"),
    /PROVIDER_HTTP_503/,
  );
});

test("the daily job checks due carriers, records failures, retries them after an hour and skips without a provider", async () => {
  const [a, b, c, d] = [
    await tenant("AuthorityJobA"),
    await tenant("AuthorityJobB"),
    await tenant("AuthorityJobC"),
    await tenant("AuthorityJobD"),
  ];
  await setDot(a.carrier, "4000001");
  await setDot(a.foreign, "4000002", "team"); // setup unfinished: never checked
  const history = (
    carrier: string,
    outcome: "ok" | "error",
    ageHours: number,
    n = 1,
  ) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        pool.query(
          `INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,error_code,observed_at,created_at)
           VALUES($1,$2,'4000003','fixture',$3,$4,now(),now()-make_interval(mins=>($5::int+$6::int)))`,
          [
            randomUUID(),
            carrier,
            outcome,
            outcome === "error" ? "TIMEOUT" : null,
            ageHours,
            i,
          ],
        ),
      ),
    );
  await setDot(b.carrier, "4000003");
  await history(b.carrier, "error", 120); // failed 2 hours ago: retry now
  await setDot(c.carrier, "4000003");
  await history(c.carrier, "error", 12); // failed minutes ago: wait
  await setDot(d.carrier, "4000003");
  await history(d.carrier, "error", 120, 4); // failed four times running: wait for the daily pass
  const seen: string[] = [];
  const flaky = {
    source: "fixture" as const,
    async lookup(usdot: string, name: string) {
      seen.push(name);
      if (usdot === "4000001") throw new Error("socket hang up: 10.0.0.1");
      return fixtureProvider.lookup(usdot, name);
    },
  };
  const count = async (carrier: string) =>
    (
      await pool.query(
        "SELECT count(*)::int n FROM carrier_authority_checks WHERE carrier_id=$1",
        [carrier],
      )
    ).rows[0].n;
  const result = (await runAuthorityChecks(500, flaky)) as {
    checked: number;
    failed: number;
  };
  assert.ok(result.checked >= 2 && result.failed >= 1);
  assert.equal(await count(a.carrier), 1); // new carrier: checked once, and it failed
  const failure = (
    await pool.query(
      "SELECT outcome,error_code FROM carrier_authority_checks WHERE carrier_id=$1",
      [a.carrier],
    )
  ).rows[0];
  // The stored code is from a fixed vocabulary, never the provider's message.
  assert.deepEqual(failure, { outcome: "error", error_code: "LOOKUP_FAILED" });
  assert.equal(await count(a.foreign), 0);
  assert.equal(await count(b.carrier), 2);
  assert.equal(await count(c.carrier), 1);
  assert.equal(await count(d.carrier), 4);
  // Run again straight away: nothing is due.
  const again = (await runAuthorityChecks(500, flaky)) as { checked: number };
  assert.equal(again.checked, 0);
  // Without a configured provider in production, nothing is recorded as if it were real.
  const env = process.env.NODE_ENV;
  const chosen = process.env.RELAY_AUTHORITY_PROVIDER;
  delete process.env.RELAY_AUTHORITY_PROVIDER;
  (process.env as Record<string, string>).NODE_ENV = "production";
  try {
    assert.throws(() => configuredProvider(), {
      code: "AUTHORITY_PROVIDER_NOT_CONFIGURED",
    });
    assert.deepEqual(await runAuthorityChecks(), {
      skipped: "no provider configured",
    });
    process.env.RELAY_AUTHORITY_PROVIDER = "fixture";
    assert.equal(configuredProvider().source, "fixture");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
    if (chosen === undefined) delete process.env.RELAY_AUTHORITY_PROVIDER;
    else process.env.RELAY_AUTHORITY_PROVIDER = chosen;
  }
});

test("carriers that need a person are counted for the operations alert", async () => {
  const fresh = await tenant("AuthorityAlert");
  await setDot(fresh.carrier, "5000008");
  const before = await authorityAttention();
  await checkAuthority(fresh.dispatcher, {
    carrier_id: fresh.carrier,
    key: randomUUID(),
  });
  assert.equal((await authorityAttention()) - before, 1);
  await setDot(fresh.carrier, "5000001");
  await checkAuthority(fresh.dispatcher, {
    carrier_id: fresh.carrier,
    key: randomUUID(),
  });
  assert.equal((await authorityAttention()) - before, 0);
});

test("a lookup speaks only for the USDOT number it was made for", async () => {
  const fresh = await tenant("AuthorityNumber");
  await setDot(fresh.carrier, "6000001");
  await checkAuthority(fresh.dispatcher, {
    carrier_id: fresh.carrier,
    key: randomUUID(),
  });
  assert.equal(
    (await authorityStatus(fresh.dispatcher, fresh.carrier)).state,
    "clear",
  );
  const before = await authorityAttention();
  // The number is swapped for another company's: the old "clear" must not carry over.
  await setDot(fresh.carrier, "6000008");
  const changed = await authorityStatus(fresh.dispatcher, fresh.carrier);
  assert.deepEqual(
    [changed.state, changed.flags, changed.usdot, changed.observed_at],
    ["attention", ["usdot_changed"], "6000008", null],
  );
  assert.equal((await authorityAttention()) - before, 1);
  // The daily job looks the new number up at once, although the last lookup is minutes old.
  const seen: string[] = [];
  await runAuthorityChecks(5000, {
    source: "fixture",
    async lookup(usdot, name) {
      seen.push(usdot);
      return fixtureProvider.lookup(usdot, name);
    },
  });
  assert.ok(seen.includes("6000008"));
  const after = await authorityStatus(fresh.dispatcher, fresh.carrier);
  assert.equal(after.state, "attention");
  assert.ok(after.flags.includes("authority_revoked"));
  assert.ok(!after.flags.includes("usdot_changed"));
  // Changing back to the number that was looked up reads as that lookup again.
  await setDot(fresh.carrier, "6000001");
  assert.equal(
    (await authorityStatus(fresh.dispatcher, fresh.carrier)).state,
    "clear",
  );
});

test("'Check now' has a cooldown, but a replay of the same request is answered", async () => {
  const fresh = await tenant("AuthorityCooldown");
  await setDot(fresh.carrier, "7000001");
  process.env.RELAY_AUTHORITY_COOLDOWN_SECONDS = "1";
  try {
    const key = randomUUID();
    await checkAuthority(fresh.dispatcher, { carrier_id: fresh.carrier, key });
    // Another press straight away is refused without looking anything up.
    await assert.rejects(
      checkAuthority(fresh.dispatcher, {
        carrier_id: fresh.carrier,
        key: randomUUID(),
      }),
      { code: "CHECK_TOO_SOON" },
    );
    // A retry of the first request (a lost reply) is replayed, not refused.
    assert.equal(
      (
        await checkAuthority(fresh.dispatcher, {
          carrier_id: fresh.carrier,
          key,
        })
      ).state,
      "clear",
    );
    const count = async () =>
      (
        await pool.query(
          "SELECT count(*)::int n FROM carrier_authority_checks WHERE carrier_id=$1",
          [fresh.carrier],
        )
      ).rows[0].n;
    assert.equal(await count(), 1);
    await new Promise((r) => setTimeout(r, 1100));
    await checkAuthority(fresh.dispatcher, {
      carrier_id: fresh.carrier,
      key: randomUUID(),
    });
    assert.equal(await count(), 2);
  } finally {
    process.env.RELAY_AUTHORITY_COOLDOWN_SECONDS = "0";
  }
});

test("the daily job stops at its time budget, says what it left, and finishes the rest next run", async () => {
  const carriers: string[] = [];
  for (const label of [
    "AuthorityBudgetA",
    "AuthorityBudgetB",
    "AuthorityBudgetC",
  ]) {
    const x = await tenant(label);
    carriers.push(x.carrier, x.foreign);
  }
  for (const [i, id] of carriers.entries()) await setDot(id, "800000" + i);
  const seen: string[] = [];
  const slow = {
    source: "fixture" as const,
    async lookup(usdot: string, name: string) {
      seen.push(usdot);
      await new Promise((r) => setTimeout(r, 60));
      return fixtureProvider.lookup(usdot, name);
    },
  };
  const first = (await runAuthorityChecks(6, slow, {
    budgetMs: 100,
    concurrency: 1,
  })) as {
    checked: number;
    deferred: number;
  };
  assert.ok(first.checked >= 1 && first.deferred >= 1);
  assert.equal(first.checked + first.deferred, 6);
  // Lookups already under way finish; none starts after the budget.
  assert.ok(first.checked <= 3);
  const second = (await runAuthorityChecks(6, slow, {
    budgetMs: 10_000,
    concurrency: 3,
  })) as {
    checked: number;
    deferred: number;
  };
  assert.equal(second.deferred, 0);
  assert.ok(second.checked >= first.deferred);
  for (let i = 0; i < 6; i++)
    assert.ok(seen.includes("800000" + i), "800000" + i);
});

test("four failed lookups in a row raise an operations alert", async () => {
  const fresh = await tenant("AuthorityFailing");
  await setDot(fresh.carrier, "9000001");
  const before = await authorityFailing();
  for (let i = 0; i < 4; i++)
    await pool.query(
      "INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,error_code,observed_at) VALUES($1,$2,'9000001','fmcsa','error','TIMEOUT',now())",
      [randomUUID(), fresh.carrier],
    );
  assert.equal((await authorityFailing()) - before, 1);
  const alerts = await collectAlerts([]);
  const alert = alerts.find((a) => a.key === "authority.failing");
  assert.ok(alert);
  assert.match(alert!.text, /failed four times in a row/);
  // A success clears it.
  await pool.query(
    "INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,legal_name,authority_status,observed_at) VALUES($1,$2,'9000001','fmcsa','ok','x','active',now())",
    [randomUUID(), fresh.carrier],
  );
  assert.equal((await authorityFailing()) - before, 0);
});
