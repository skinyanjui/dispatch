import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { detail } from "../../src/lib/loads";
import { cancelLoad, editLoad } from "../../src/lib/load-changes";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("ChangeRequests");
});
after(() => pool.end());

const rows = async (sql: string, ...args: unknown[]) =>
  (await pool.query(sql, args)).rows;

test("a retried edit with the same key replays instead of failing on the new version", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const key = randomUUID();
  const body = { version: load.version, amountMinor: 275000 };
  const first = await editLoad(t.dispatcher, load.id, body, key);
  const again = await editLoad(t.dispatcher, load.id, body, key);
  assert.deepEqual(again, first);
  const d = await detail(t.dispatcher, load.id);
  assert.equal(d.version, load.version + 1);
  assert.equal(d.changes.length, 1);
  // Without a key the same stale request is still a version conflict.
  await assert.rejects(editLoad(t.dispatcher, load.id, body), {
    code: "VERSION_CONFLICT",
  });
  // The same key cannot be reused for different input or for another action.
  await assert.rejects(
    editLoad(t.dispatcher, load.id, { ...body, amountMinor: 1 }, key),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    cancelLoad(
      t.dispatcher,
      load.id,
      { version: load.version, reason: "x" },
      key,
    ),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.equal(
    (
      await rows(
        "SELECT 1 FROM audit_logs WHERE resource_id=$1 AND action='load.edited'",
        load.id,
      )
    ).length,
    1,
  );
});

test("a retried cancel replays, even though the load is now read-only", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const key = randomUUID();
  const body = { version: load.version, reason: "Broker withdrew" };
  const first = await cancelLoad(t.dispatcher, load.id, body, key);
  assert.deepEqual(await cancelLoad(t.dispatcher, load.id, body, key), first);
  assert.equal(
    (
      await rows(
        "SELECT 1 FROM audit_logs WHERE resource_id=$1 AND action='load.cancelled'",
        load.id,
      )
    ).length,
    1,
  );
  // A different key on a cancelled load is rejected, not replayed.
  await assert.rejects(cancelLoad(t.dispatcher, load.id, body, randomUUID()), {
    code: "LOAD_CANCELLED",
  });
  await assert.rejects(
    editLoad(
      t.dispatcher,
      load.id,
      { version: first.version, source: "x" },
      randomUUID(),
    ),
    { code: "LOAD_CANCELLED" },
  );
});

test("keys cannot reach other tenants' loads or replay their results", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const key = randomUUID();
  const body = { version: load.version, source: "Corrected" };
  await editLoad(t.dispatcher, load.id, body, key);
  // Guessing the load ID — with the victim's own key — is still a 404.
  await assert.rejects(editLoad(t.foreignManager, load.id, body, key), {
    code: "NOT_FOUND",
  });
  const token = await sessionFor(t.foreignManager);
  for (const [path, json] of [
    ["edit", body],
    ["cancel", { version: load.version, reason: "Hacked" }],
  ] as const) {
    const res = await POST(
      request(`loads/${load.id}/${path}`, {
        token,
        json,
        headers: { "idempotency-key": key },
      }),
    );
    assert.equal(res.status, 404);
  }
  // A blank key is rejected rather than silently ignored.
  const mine = await sessionFor(t.dispatcher);
  const blank = await POST(
    request(`loads/${load.id}/edit`, {
      token: mine,
      json: { version: load.version + 1, source: "Again" },
      headers: { "idempotency-key": "" },
    }),
  );
  assert.equal(blank.status, 400);
  assert.equal((await detail(t.dispatcher, load.id)).cancelled_at, null);
});

test("the request log is append-only", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await editLoad(
    t.dispatcher,
    load.id,
    { version: load.version, source: "Logged" },
    randomUUID(),
  );
  await assert.rejects(
    pool.query("DELETE FROM load_change_requests WHERE load_id=$1", [load.id]),
    /Append-only/,
  );
});
