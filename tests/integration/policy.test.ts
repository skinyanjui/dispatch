import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { enforceAudience, familyAudience } from "../../src/lib/policy";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Policy");
});
after(() => pool.end());

const routed = [
  ...new Set(
    [
      ...readFileSync("src/app/api/[...path]/route.ts", "utf8").matchAll(
        /path\[0\] === "([a-z-]+)"/g,
      ),
    ].map((m) => m[1]),
  ),
];

test("every routed API family has a declared audience, and none is stale", () => {
  assert.deepEqual(
    routed.filter((f) => !(f in familyAudience)),
    [],
    "declare new families in src/lib/policy.ts",
  );
  assert.deepEqual(
    Object.keys(familyAudience).filter((f) => !routed.includes(f)),
    [],
    "remove families the router no longer serves",
  );
});

const families = (audience: string) =>
  Object.entries(familyAudience)
    .filter(([, a]) => a === audience)
    .map(([f]) => f);

test("staff-only families answer outsiders 404 before reading the body, and staff get field errors", async () => {
  for (const family of families("staff")) {
    for (const user of [t.manager, t.driverUser]) {
      for (const path of [family, family + "/" + t.carrier]) {
        const res = await POST(
          request(path, {
            token: await sessionFor(user),
            json: { garbage: 1 },
          }),
        );
        assert.equal(
          res.status,
          404,
          `${family} gave ${res.status} to an outsider`,
        );
        assert.deepEqual(await res.json(), { error: "NOT_FOUND" });
      }
    }
    // The same malformed body reaches validation for staff.
    const res = await POST(
      request(family === "assistant" ? "assistant/ask" : family, {
        token: await sessionFor(t.dispatcher),
        json: { garbage: 1 },
      }),
    );
    assert.notEqual(
      res.status,
      404,
      `${family} should reach its handler for staff`,
    );
  }
});

test("non-driver families are closed to drivers only", async () => {
  for (const family of families("non-driver")) {
    for (const path of [family, family + "/x"]) {
      const res = await GET(
        request(path, { token: await sessionFor(t.driverUser) }),
      );
      assert.equal(res.status, 404, path);
      const post = await POST(
        request(path, {
          token: await sessionFor(t.driverUser),
          json: { garbage: 1 },
        }),
      );
      assert.deepEqual(await post.json(), { error: "NOT_FOUND" }, path);
    }
    for (const user of [t.manager, t.dispatcher])
      await enforceAudience(user, family); // does not throw
  }
});

test("org-admin families are closed to dispatchers and managers", async () => {
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",
    [t.organization, t.dispatcher],
  );
  for (const family of families("org-admin")) {
    for (const user of [t.manager, t.driverUser])
      await assert.rejects(enforceAudience(user, family), { status: 404 });
    await enforceAudience(t.dispatcher, family);
  }
});

test("an undeclared family is a 404 for a signed-in person", async () => {
  const res = await GET(
    request("not-a-family", { token: await sessionFor(t.dispatcher) }),
  );
  assert.equal(res.status, 404);
});

test("refusals are recorded in the audit log", async () => {
  await POST(
    request("prospects", { token: await sessionFor(t.driverUser), json: {} }),
  );
  const row = await pool.query(
    "SELECT 1 FROM audit_logs WHERE actor_id=$1 AND resource_id LIKE '%/api/prospects%' ORDER BY created_at DESC LIMIT 1",
    [t.driverUser],
  );
  assert.equal(row.rowCount, 1);
});
