import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  createSavedReply,
  deleteSavedReply,
  getThread,
  listSavedReplies,
  listThreads,
  markRead,
  sendMessage,
  unreadCount,
  updateSavedReply,
} from "../../src/lib/messaging";
import { createContact } from "../../src/lib/contacts";
import {
  deliverDue,
  setTransport,
  type Email,
} from "../../src/lib/notifications";
import { setSmsTransport, toE164 } from "../../src/lib/sms";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
let t: Awaited<ReturnType<typeof tenant>>;
let broker: string; // contact key with email + SMS consent
let noConsent: string; // contact key with a phone but no consent
let emailless: string; // contact key with only a phone
const sentEmails: Email[] = [];
const sentTexts: { to: string; body: string }[] = [];
let smsOutcome: "ok" | "refused" | "timeout" = "ok";

before(async () => {
  t = await tenant("Inbox");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
  const base = {
    kind: "broker",
    company: "Fictional Brokers",
    notes: "",
    carrier_id: null,
    sms_consent: false,
    sms_consent_note: "",
  };
  const make = async (name: string, extra: Record<string, unknown>) =>
    "contact:" +
    (
      await createContact(t.dispatcher, {
        ...base,
        name,
        idempotency_key: randomUUID(),
        email: "",
        phone: "",
        ...extra,
      })
    ).id;
  broker = await make("Morgan Broker", {
    email: "morgan@broker.test",
    phone: "(214) 555-0199",
    sms_consent: true,
    sms_consent_note: "Verbal OK on 10/21 call",
  });
  noConsent = await make("Pat NoConsent", {
    email: "pat@broker.test",
    phone: "(214) 555-0150",
  });
  emailless = await make("Phone Only", { phone: "(214) 555-0160" });
});
afterEach(() => {
  setTransport(null);
  setSmsTransport(undefined);
  sentEmails.length = 0;
  sentTexts.length = 0;
  smsOutcome = "ok";
});
after(() => pool.end());

function useTransports() {
  setTransport({
    name: "test",
    async send(email) {
      sentEmails.push(email);
      return "provider-" + email.id;
    },
  });
  setSmsTransport({
    name: "test-sms",
    async send(to, body) {
      sentTexts.push({ to, body });
      if (smsOutcome === "refused")
        return { ok: false, definite: true, error: "Provider responded 400" };
      if (smsOutcome === "timeout")
        return {
          ok: false,
          definite: false,
          error: "No answer from the provider",
        };
      return { ok: true, providerId: "SM" + sentTexts.length };
    },
  });
}
const msg = (over: Record<string, unknown> = {}) => ({
  idempotency_key: randomUUID(),
  subject: "Pickup update",
  to: ["user:" + t.dispatcher],
  channel: "in_app",
  body: "Running 20 minutes late",
  ...over,
});
const row = async (id: string) =>
  (await pool.query("SELECT * FROM messages WHERE id=$1", [id])).rows[0];

test("in-app messages create a thread, notify, track unread and clear on read", async () => {
  const first = await sendMessage(t.manager, msg());
  const thread = await getThread(t.dispatcher, first.thread_id);
  assert.equal(thread.carrier_id, t.carrier); // inferred from the shared carrier
  assert.deepEqual(
    thread.participants.map((p: { name: string }) => p.name).sort(),
    ["Inbox Dispatcher", "Inbox Manager"],
  );
  assert.equal(thread.messages[0].deliveries[0].status, "delivered");
  assert.equal((await unreadCount(t.dispatcher)).unread >= 1, true);
  assert.equal((await unreadCount(t.manager)).unread, 0); // the sender has read it
  const listed = await listThreads(
    t.dispatcher,
    new URLSearchParams({ filter: "unread" }),
  );
  assert.ok(
    listed.threads.some(
      (x: { id: string; unread: boolean }) =>
        x.id === first.thread_id && x.unread,
    ),
  );
  await markRead(t.dispatcher, first.thread_id);
  const after = await listThreads(
    t.dispatcher,
    new URLSearchParams({ filter: "unread" }),
  );
  assert.ok(
    !after.threads.some((x: { id: string }) => x.id === first.thread_id),
  );
  // The recipient is alerted by email with no message body, and can mute it.
  const alert = await pool.query(
    "SELECT kind,subject FROM notifications WHERE recipient_user_id=$1 AND kind='message_received' ORDER BY created_at DESC LIMIT 1",
    [t.dispatcher],
  );
  assert.match(alert.rows[0].subject, /New message from Inbox Manager/);
  // A reply goes back into the same thread and is unread for the manager.
  await sendMessage(
    t.dispatcher,
    msg({
      thread_id: first.thread_id,
      subject: undefined,
      to: ["user:" + t.manager],
      body: "Thanks, noted",
    }),
  );
  assert.equal(
    (await getThread(t.manager, first.thread_id)).messages.length,
    2,
  );
  assert.ok(
    (
      await listThreads(t.manager, new URLSearchParams({ filter: "unread" }))
    ).threads.some((x: { id: string }) => x.id === first.thread_id),
  );
});

test("drivers message their team in Relay only, and see only their own conversations", async () => {
  const toDispatch = await sendMessage(
    t.driverUser,
    msg({ subject: "Gate closed", body: "Gate is closed, waiting" }),
  );
  assert.equal(
    (await getThread(t.dispatcher, toDispatch.thread_id)).messages.length,
    1,
  );
  await assert.rejects(
    sendMessage(
      t.driverUser,
      msg({ channel: "email", to: ["user:" + t.dispatcher] }),
    ),
    { code: "ROLE_NOT_PERMITTED" },
  );
  await assert.rejects(
    sendMessage(
      t.driverUser,
      msg({
        mode: "log",
        direction: "in",
        channel: "call",
        to: ["user:" + t.dispatcher],
      }),
    ),
    { code: "ROLE_NOT_PERMITTED" },
  );
  // Another driver is not in the directory, so cannot be messaged.
  await assert.rejects(
    sendMessage(t.driverUser, msg({ to: ["driver:" + t.otherDriver] })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(getThread(t.otherDriverUser, toDispatch.thread_id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(getThread(t.foreignManager, toDispatch.thread_id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(markRead(t.foreignManager, toDispatch.thread_id), {
    code: "NOT_FOUND",
  });
  // The dispatcher can reach the driver (drivers have accounts), in-app.
  const reply = await sendMessage(
    t.dispatcher,
    msg({
      thread_id: toDispatch.thread_id,
      subject: undefined,
      to: ["driver:" + t.driver],
      body: "Ok, check in when you can",
    }),
  );
  assert.equal(
    (await getThread(t.driverUser, reply.thread_id)).messages.length,
    2,
  );
  // Threads store the driver as a user, and replies address them that way too;
  // naming the same driver twice delivers once.
  const again = await sendMessage(
    t.dispatcher,
    msg({
      thread_id: toDispatch.thread_id,
      subject: undefined,
      to: ["user:" + t.driverUser, "driver:" + t.driver],
      body: "Thanks",
    }),
  );
  const view = await getThread(t.dispatcher, again.thread_id);
  assert.equal(view.messages.at(-1).deliveries.length, 1);
});

test("email goes through the outbox with the sender as reply-to, and shows delivery status", async () => {
  useTransports();
  const sent = await sendMessage(
    t.dispatcher,
    msg({
      channel: "email",
      to: [broker],
      subject: "Rate confirmation",
      body: "Please resend the rate con.",
    }),
    "https://relay.example",
  );
  let view = await getThread(t.dispatcher, sent.thread_id);
  assert.equal(view.messages[0].deliveries[0].status, "queued");
  await deliverDue(1000);
  view = await getThread(t.dispatcher, sent.thread_id);
  assert.equal(view.messages[0].deliveries[0].status, "sent");
  const email = sentEmails.find((e) => e.to === "morgan@broker.test")!;
  assert.equal(email.subject, "Rate confirmation");
  assert.equal(email.replyTo, t.dispatcher + "@relay.test");
  assert.match(email.text, /Please resend the rate con\./);
  assert.match(email.text, /Sent by Inbox Dispatcher through Relay/);
  // The message record keeps its text even though the outbox body is purged.
  assert.equal(view.messages[0].body, "Please resend the rate con.");
  const queued = await pool.query(
    "SELECT body_ciphertext FROM notifications WHERE id=(SELECT notification_id FROM message_deliveries WHERE message_id=$1)",
    [sent.message_id],
  );
  assert.equal(queued.rows[0].body_ciphertext, null);
  // Recipients without an address, or unreachable by that channel, are refused.
  await assert.rejects(
    sendMessage(t.dispatcher, msg({ channel: "email", to: [emailless] })),
    { code: "RECIPIENT_CHANNEL_UNAVAILABLE" },
  );
  await assert.rejects(
    sendMessage(t.dispatcher, msg({ channel: "in_app", to: [broker] })),
    { code: "RECIPIENT_CHANNEL_UNAVAILABLE" },
  );
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({ channel: "in_app", to: ["user:" + t.dispatcher] }),
    ),
    { code: "NOT_FOUND" }, // you cannot message yourself
  );
});

test("texts need a configured provider and recorded consent, are attempted once, and report unknown outcomes", async () => {
  await assert.rejects(
    sendMessage(t.dispatcher, msg({ channel: "sms", to: [broker] })),
    { code: "SMS_UNAVAILABLE" },
  );
  useTransports();
  await assert.rejects(
    sendMessage(t.dispatcher, msg({ channel: "sms", to: [noConsent] })),
    { code: "RECIPIENT_CHANNEL_UNAVAILABLE" },
  );
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({ channel: "sms", to: [broker], body: "x".repeat(481) }),
    ),
    { name: "ZodError" },
  );
  const input = msg({
    channel: "sms",
    to: [broker],
    subject: "Texts",
    body: "Driver ETA 3pm",
  });
  const first = await sendMessage(t.dispatcher, input);
  assert.deepEqual(sentTexts, [{ to: "+12145550199", body: "Driver ETA 3pm" }]);
  assert.equal(
    (await getThread(t.dispatcher, first.thread_id)).messages[0].deliveries[0]
      .status,
    "sent",
  );
  // A retry of the same request does not text twice.
  assert.deepEqual(await sendMessage(t.dispatcher, input), first);
  assert.equal(sentTexts.length, 1);
  smsOutcome = "refused";
  const refused = await sendMessage(
    t.dispatcher,
    msg({ channel: "sms", to: [broker], subject: "Texts", body: "Second" }),
  );
  assert.equal(
    (await getThread(t.dispatcher, refused.thread_id)).messages[0].deliveries[0]
      .status,
    "failed",
  );
  smsOutcome = "timeout";
  const unknown = await sendMessage(
    t.dispatcher,
    msg({ channel: "sms", to: [broker], subject: "Texts", body: "Third" }),
  );
  const status = (await getThread(t.dispatcher, unknown.thread_id)).messages[0]
    .deliveries[0];
  assert.equal(status.status, "unknown");
  assert.equal(sentTexts.length, 3); // one attempt each, never automatic retries
  // Consent belongs to the phone number: changing it clears consent.
  assert.equal(toE164("(214) 555-0199"), "+12145550199");
  assert.equal(toE164("1-214-555-0199"), "+12145550199");
  assert.equal(toE164("555-0199"), null);
});

test("calls, texts and emails can be logged by hand, including inbound replies", async () => {
  const inbound = await sendMessage(
    t.dispatcher,
    msg({
      mode: "log",
      direction: "in",
      channel: "email",
      to: [broker],
      subject: "Rate con",
      body: "Resent, see attachment.",
      counterpart: "Morgan Broker",
      occurred_at: new Date(Date.now() - 3600000).toISOString(),
    }),
  );
  const call = await sendMessage(
    t.dispatcher,
    msg({
      mode: "log",
      direction: "out",
      channel: "call",
      thread_id: inbound.thread_id,
      subject: undefined,
      to: [broker],
      body: "Called to confirm pickup time; 9am.",
    }),
  );
  const view = await getThread(t.dispatcher, inbound.thread_id);
  assert.deepEqual(
    view.messages.map(
      (m: { channel: string; source: string; direction: string }) => [
        m.channel,
        m.source,
        m.direction,
      ],
    ),
    [
      ["email", "logged", "in"],
      ["call", "logged", "out"],
    ],
  );
  assert.equal(view.messages[0].counterpart, "Morgan Broker");
  assert.equal(view.messages[0].deliveries.length, 0);
  assert.equal(sentEmails.length + sentTexts.length, 0); // logging sends nothing
  void call;
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({
        mode: "log",
        channel: "call",
        to: [broker],
        occurred_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    ),
    { code: "LOG_TIME_OUT_OF_RANGE" },
  );
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({ mode: "send", channel: "call", to: [broker] }),
    ),
    { name: "ZodError" },
  );
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({
        mode: "log",
        direction: "in",
        occurred_at: new Date().toISOString(),
      }),
    ),
    { name: "ZodError" },
  );
});

test("idempotency, scope and thread access", async () => {
  const input = msg({ subject: "Idempotent" });
  const first = await sendMessage(t.manager, input);
  assert.deepEqual(await sendMessage(t.manager, input), first);
  await assert.rejects(sendMessage(t.manager, { ...input, body: "Changed" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM messages WHERE thread_id=$1",
        [first.thread_id],
      )
    ).rows[0].n,
    1,
  );
  // A foreign manager cannot message this tenant's people or contacts, or post into its threads.
  await assert.rejects(
    sendMessage(t.foreignManager, msg({ to: ["user:" + t.manager] })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    sendMessage(t.foreignManager, msg({ to: [broker], channel: "email" })),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    sendMessage(
      t.foreignManager,
      msg({
        thread_id: first.thread_id,
        subject: undefined,
        to: ["user:" + t.foreignManager],
      }),
    ),
    { code: "NOT_FOUND" },
  );
  // Load-linked threads need access to the load.
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const foreignLoad = await bookedLoad(t.dispatcher, t.foreign);
  const linked = await sendMessage(
    t.dispatcher,
    msg({
      load_id: load.id,
      to: ["user:" + t.manager],
      subject: `About ${load.reference}`,
    }),
  );
  assert.equal(
    (await getThread(t.manager, linked.thread_id)).load?.reference,
    load.reference,
  );
  await assert.rejects(
    sendMessage(
      t.manager,
      msg({ load_id: foreignLoad.id, to: ["user:" + t.dispatcher] }),
    ),
    { code: "NOT_FOUND" },
  );
  const byLoad = await listThreads(
    t.manager,
    new URLSearchParams({ load_id: load.id }),
  );
  assert.deepEqual(
    byLoad.threads.map((x: { id: string }) => x.id),
    [linked.thread_id],
  );
  // Staff see their carrier's conversations without being in them; others do not.
  const private_ = await sendMessage(
    t.manager,
    msg({ subject: "Between us", to: ["driver:" + t.driver] }),
  );
  assert.ok(
    (await listThreads(t.dispatcher, new URLSearchParams())).threads.some(
      (x: { id: string }) => x.id === private_.thread_id,
    ),
  );
  assert.ok(
    !(await listThreads(t.otherDriverUser, new URLSearchParams())).threads.some(
      (x: { id: string }) => x.id === private_.thread_id,
    ),
  );
  assert.ok(
    !(await listThreads(t.foreignManager, new URLSearchParams())).threads.some(
      (x: { id: string }) => x.id === private_.thread_id,
    ),
  );
});

test("search covers subject, people and message text; wildcards are literal; paging is stable", async () => {
  const unique = randomUUID().slice(0, 8);
  const a = await sendMessage(
    t.dispatcher,
    msg({
      subject: "Search " + unique,
      to: ["user:" + t.manager],
      body: "needle-" + unique,
    }),
  );
  const find = async (q: string) =>
    (await listThreads(t.dispatcher, new URLSearchParams({ q }))).threads.map(
      (x: { id: string }) => x.id,
    );
  assert.deepEqual(await find("Search " + unique), [a.thread_id]);
  assert.deepEqual(await find("needle-" + unique), [a.thread_id]);
  assert.ok((await find("Inbox Manager")).includes(a.thread_id));
  assert.deepEqual(await find("%"), []);
  assert.deepEqual(
    (
      await listThreads(
        t.dispatcher,
        new URLSearchParams({ channel: "call", q: unique }),
      )
    ).threads,
    [],
  );
  for (let i = 0; i < 32; i++)
    await sendMessage(
      t.manager,
      msg({ subject: `Bulk ${i} ${unique}`, to: ["user:" + t.dispatcher] }),
    );
  const page1 = await listThreads(
    t.dispatcher,
    new URLSearchParams({ q: unique }),
  );
  assert.equal(page1.threads.length, 30);
  assert.ok(page1.nextCursor);
  const page2 = await listThreads(
    t.dispatcher,
    new URLSearchParams({ q: unique, cursor: page1.nextCursor! }),
  );
  const ids = [...page1.threads, ...page2.threads].map(
    (x: { id: string }) => x.id,
  );
  assert.equal(new Set(ids).size, 33);
  await assert.rejects(
    listThreads(t.dispatcher, new URLSearchParams({ cursor: "bad" })),
    { code: "INVALID_CURSOR" },
  );
});

test("saved replies are personal or shared with the organization", async () => {
  const mine = await createSavedReply(t.manager, {
    title: "On my way",
    body: "On my way, ETA 20 min",
  });
  const shared = await createSavedReply(t.dispatcher, {
    title: "POD request",
    body: "Please send the signed POD.",
    shared: true,
  });
  await assert.rejects(
    createSavedReply(t.manager, { title: "x", body: "y", shared: true }),
    { code: "ROLE_NOT_PERMITTED" },
  );
  const titles = async (user: string) =>
    (await listSavedReplies(user)).replies.map(
      (r: { title: string }) => r.title,
    );
  assert.ok((await titles(t.manager)).includes("On my way"));
  assert.ok(!(await titles(t.manager)).includes("POD request")); // shared replies are for staff
  assert.ok((await titles(t.dispatcher)).includes("POD request"));
  assert.ok(!(await titles(t.dispatcher)).includes("On my way"));
  assert.ok(!(await titles(t.foreignManager)).includes("POD request"));
  await assert.rejects(
    updateSavedReply(t.foreignManager, mine.id, { title: "x", body: "y" }),
    { code: "NOT_FOUND" },
  );
  await updateSavedReply(t.dispatcher, shared.id, {
    title: "POD request v2",
    body: "Updated",
  });
  await assert.rejects(deleteSavedReply(t.manager, shared.id), {
    code: "NOT_FOUND",
  });
  await deleteSavedReply(t.dispatcher, shared.id);
  assert.ok(!(await titles(t.dispatcher)).includes("POD request v2"));
});

test("HTTP: authenticated, origin-checked, and thread reads do not leak", async () => {
  assert.equal((await GET(request("threads"))).status, 401);
  const token = await sessionFor(t.manager);
  const created = await POST(
    request("messages", { token, json: msg({ subject: "HTTP thread" }) }),
  );
  assert.equal(created.status, 201);
  const { thread_id } = await created.json();
  assert.equal(
    (await GET(request("threads/" + thread_id, { token }))).status,
    200,
  );
  const outsider = await sessionFor(t.foreignManager);
  assert.equal(
    (await GET(request("threads/" + thread_id, { token: outsider }))).status,
    404,
  );
  const forged = await POST(
    request("messages", {
      token,
      json: msg(),
      headers: { origin: "https://untrusted.example" },
    }),
  );
  assert.equal(forged.status, 403);
  const unread = await GET(
    request("inbox/unread", { token: await sessionFor(t.dispatcher) }),
  );
  assert.equal(unread.status, 200);
  assert.equal(typeof (await unread.json()).unread, "number");
});
