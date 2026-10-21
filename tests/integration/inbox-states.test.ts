import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  listThreads,
  markRead,
  sendMessage,
  threadCounts,
  unreadCount,
} from "../../src/lib/messaging";
import { request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
after(() => pool.end());
let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("States");
  other = await tenant("StatesOther");
});

const send = (
  from: string,
  to: string,
  subject = "Pickup " + randomUUID().slice(0, 6),
) =>
  sendMessage(from, {
    idempotency_key: randomUUID(),
    subject,
    to: ["user:" + to],
    channel: "in_app",
    body: "Hello",
  });
const ids = async (user: string, view?: string) =>
  (
    await listThreads(user, new URLSearchParams(view ? { view } : {}))
  ).threads.map((x: { id: string }) => x.id);
const act = async (user: string, thread: string, action: string) => {
  const token = await sessionFor(user);
  return POST(request(`threads/${thread}/${action}`, { token, json: {} }));
};

test("mark unread brings a read conversation back to unread until it is opened", async () => {
  const { thread_id } = await send(t.manager, t.dispatcher);
  await markRead(t.dispatcher, thread_id);
  const before = (await unreadCount(t.dispatcher)).unread;
  assert.equal((await act(t.dispatcher, thread_id, "unread")).status, 200);
  assert.equal((await unreadCount(t.dispatcher)).unread, before + 1);
  const row = (
    await listThreads(t.dispatcher, new URLSearchParams({ filter: "unread" }))
  ).threads.find((x: { id: string }) => x.id === thread_id);
  assert.equal(row.unread, true);
  // The other person is unaffected.
  assert.equal(
    (await listThreads(t.manager, new URLSearchParams())).threads.find(
      (x: { id: string }) => x.id === thread_id,
    ).unread,
    false,
  );
  await markRead(t.dispatcher, thread_id);
  assert.equal((await unreadCount(t.dispatcher)).unread, before);
  // Repeating an action is harmless.
  assert.equal((await act(t.dispatcher, thread_id, "unread")).status, 200);
  assert.equal((await act(t.dispatcher, thread_id, "unread")).status, 200);
});

test("archive and trash hide a conversation for one person only, and restore it", async () => {
  const { thread_id } = await send(t.manager, t.dispatcher);
  assert.ok((await ids(t.dispatcher)).includes(thread_id));
  await act(t.dispatcher, thread_id, "archive");
  assert.ok(!(await ids(t.dispatcher)).includes(thread_id));
  assert.ok((await ids(t.dispatcher, "archived")).includes(thread_id));
  assert.ok((await ids(t.manager)).includes(thread_id)); // others keep it
  assert.ok(!(await ids(t.manager, "archived")).includes(thread_id));
  await act(t.dispatcher, thread_id, "unarchive");
  assert.ok((await ids(t.dispatcher)).includes(thread_id));
  await act(t.dispatcher, thread_id, "trash");
  assert.ok(!(await ids(t.dispatcher)).includes(thread_id));
  assert.ok((await ids(t.dispatcher, "trash")).includes(thread_id));
  assert.ok(!(await ids(t.dispatcher, "archived")).includes(thread_id));
  await act(t.dispatcher, thread_id, "restore");
  assert.ok((await ids(t.dispatcher)).includes(thread_id));
  // Nothing was deleted.
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM messages WHERE thread_id=$1",
        [thread_id],
      )
    ).rows[0].n,
    1,
  );
});

test("a new message brings an archived or trashed conversation back", async () => {
  const a = await send(t.manager, t.dispatcher);
  const b = await send(t.manager, t.dispatcher);
  await act(t.dispatcher, a.thread_id, "archive");
  await act(t.dispatcher, b.thread_id, "trash");
  await new Promise((r) => setTimeout(r, 15));
  for (const x of [a, b])
    await sendMessage(t.manager, {
      idempotency_key: randomUUID(),
      thread_id: x.thread_id,
      to: ["user:" + t.dispatcher],
      channel: "in_app",
      body: "One more thing",
    });
  const inbox = await ids(t.dispatcher);
  assert.ok(inbox.includes(a.thread_id) && inbox.includes(b.thread_id));
});

test("archived and trashed conversations leave the unread badge; counts per tab", async () => {
  const hidden = await send(t.manager, t.dispatcher);
  const before = await threadCounts(t.dispatcher);
  await act(t.dispatcher, hidden.thread_id, "archive");
  const after = await threadCounts(t.dispatcher);
  assert.equal(after.unread, before.unread - 1);
  assert.equal(after.by_channel.in_app, before.by_channel.in_app - 1);
  assert.equal(after.archived, before.archived + 1);
  assert.equal((await unreadCount(t.dispatcher)).unread, after.unread);
  const counts = await (
    await GET(
      request("threads/counts", { token: await sessionFor(t.dispatcher) }),
    )
  ).json();
  assert.deepEqual(Object.keys(counts).sort(), [
    "archived",
    "by_channel",
    "trash",
    "unread",
  ]);
  await act(t.dispatcher, hidden.thread_id, "trash");
  assert.equal((await threadCounts(t.dispatcher)).trash, before.trash + 1);
});

test("unknown actions and foreign or unknown conversations are 404", async () => {
  const { thread_id } = await send(t.manager, t.dispatcher);
  for (const action of ["unread", "archive", "unarchive", "trash", "restore"]) {
    // Someone with no part in the conversation, in another organization.
    assert.equal(
      (await act(other.dispatcher, thread_id, action)).status,
      404,
      action,
    );
    assert.equal(
      (await act(t.dispatcher, randomUUID(), action)).status,
      404,
      action,
    );
  }
  assert.equal((await act(t.dispatcher, thread_id, "delete")).status, 404);
  const states = await pool.query(
    "SELECT 1 FROM thread_states WHERE thread_id=$1 AND user_id=$2",
    [thread_id, other.dispatcher],
  );
  assert.equal(states.rowCount, 0);
  const view = await GET(
    request("threads?view=bogus", { token: await sessionFor(t.dispatcher) }),
  );
  assert.equal(view.status, 400);
});
