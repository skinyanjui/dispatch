import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

after(() => pool.end());
let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let loadId: string;
before(async () => {
  t = await tenant("Notes");
  other = await tenant("NotesOther");
  loadId = (await bookedLoad(t.dispatcher, t.carrier)).id;
  // The driver is assigned, so a 404 below comes from the role check itself.
  await pool.query(
    "INSERT INTO load_assignments(load_id,carrier_id,driver_id) VALUES($1,$2,$3)",
    [loadId, t.carrier, t.driver],
  );
});
const post = async (user: string, id: string, body: unknown) =>
  POST(
    request(`loads/${id}/notes`, { token: await sessionFor(user), json: body }),
  );
const list = async (user: string, id: string) =>
  GET(request(`loads/${id}/notes`, { token: await sessionFor(user) }));

test("staff add notes, newest first, with the author named; a retry adds one", async () => {
  const key = randomUUID();
  const first = await post(t.dispatcher, loadId, {
    body: "Call the dock first",
    idempotency_key: key,
  });
  assert.equal(first.status, 201);
  const again = await post(t.dispatcher, loadId, {
    body: "Call the dock first",
    idempotency_key: key,
  });
  assert.equal((await again.json()).id, (await first.json()).id);
  await post(t.manager, loadId, {
    body: "Driver is running late",
    idempotency_key: randomUUID(),
  });
  const { notes } = await (await list(t.dispatcher, loadId)).json();
  assert.equal(notes.length, 2);
  assert.equal(notes[0].body, "Driver is running late");
  assert.match(notes[0].author_name, /Manager/);
  const audit = await pool.query(
    "SELECT count(*)::int n FROM audit_logs WHERE action='load.note.added' AND resource_id=$1",
    [loadId],
  );
  assert.equal(audit.rows[0].n, 2);
});

test("the same key with different text is a conflict; empty or oversize text is refused", async () => {
  const key = randomUUID();
  await post(t.dispatcher, loadId, { body: "One", idempotency_key: key });
  assert.equal(
    (await post(t.dispatcher, loadId, { body: "Two", idempotency_key: key }))
      .status,
    409,
  );
  for (const body of ["", "   ", "x".repeat(2001)])
    assert.equal(
      (
        await post(t.dispatcher, loadId, {
          body,
          idempotency_key: randomUUID(),
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await post(t.dispatcher, loadId, {
        body: "x",
        idempotency_key: randomUUID(),
        extra: 1,
      })
    ).status,
    400,
  );
});

test("drivers and other organizations get 404, for reading and writing", async () => {
  for (const user of [t.driverUser, other.dispatcher, other.manager]) {
    assert.equal((await list(user, loadId)).status, 404);
    assert.equal(
      (
        await post(user, loadId, {
          body: "Nope",
          idempotency_key: randomUUID(),
        })
      ).status,
      404,
    );
  }
  assert.equal((await list(t.dispatcher, randomUUID())).status, 404);
  assert.equal((await GET(request(`loads/${loadId}/notes`))).status, 401);
});

test("notes cannot be edited or deleted", async () => {
  const { notes } = await (await list(t.dispatcher, loadId)).json();
  await assert.rejects(
    pool.query("UPDATE load_notes SET body='x' WHERE id=$1", [notes[0].id]),
  );
  await assert.rejects(
    pool.query("DELETE FROM load_notes WHERE id=$1", [notes[0].id]),
  );
});
