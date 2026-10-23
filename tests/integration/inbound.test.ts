import test, { after, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { getThread, sendMessage, unreadCount } from "../../src/lib/messaging";
import { createContact } from "../../src/lib/contacts";
import { setTransport, type Email } from "../../src/lib/notifications";
import { setSmsTransport } from "../../src/lib/sms";
import {
  twilioSignature,
  stripQuoted,
  replyAddress,
} from "../../src/lib/inbound";
import { tenant } from "./fixtures";
import { NextRequest } from "next/server";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
process.env.RELAY_INBOUND_SECRET = "fictional-inbound-secret";
process.env.RELAY_INBOUND_EMAIL_DOMAIN = "mail.relay.test";
process.env.RELAY_SMS_TRANSPORT = "twilio";
process.env.TWILIO_AUTH_TOKEN = "fictional-twilio-token";
process.env.APP_ORIGIN = "https://relay.example.test";
let t: Awaited<ReturnType<typeof tenant>>;
let broker: string;
const emails: Email[] = [];
before(async () => {
  t = await tenant("Inbound");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
  broker =
    "contact:" +
    (
      await createContact(t.dispatcher, {
        idempotency_key: randomUUID(),
        kind: "broker",
        name: "Casey Broker",
        company: "Fictional Brokers",
        email: "casey@broker.test",
        phone: "(214) 555-0177",
        notes: "",
        carrier_id: null,
        sms_consent: true,
        sms_consent_note: "Verbal OK",
      })
    ).id;
  setTransport({
    name: "test",
    async send(email) {
      emails.push(email);
      return "p-" + email.id;
    },
  });
  setSmsTransport({
    name: "t",
    send: async () => ({ ok: true, providerId: "SM1" }),
  });
});
afterEach(() => {
  emails.length = 0;
});
after(async () => {
  setTransport(null);
  setSmsTransport(undefined);
  await pool.end();
});

const smsHook = (fields: Record<string, string>, sign = true) => {
  const params = new URLSearchParams(fields);
  const url = "https://relay.example.test/api/webhooks/sms";
  return POST(
    new NextRequest("http://localhost:3000/api/webhooks/sms", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(sign
          ? {
              "x-twilio-signature": twilioSignature(
                process.env.TWILIO_AUTH_TOKEN!,
                url,
                params,
              ),
            }
          : {}),
      },
      body: params.toString(),
    }),
  );
};
const emailHook = (
  payload: object,
  sign = true,
  secret = process.env.RELAY_INBOUND_SECRET!,
) => {
  const raw = JSON.stringify(payload);
  return POST(
    new NextRequest("http://localhost:3000/api/webhooks/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sign
          ? {
              "x-relay-signature":
                "sha256=" +
                createHmac("sha256", secret).update(raw).digest("hex"),
            }
          : {}),
      },
      body: raw,
    }),
  );
};
const textThread = async (subject: string) => {
  const sent = await sendMessage(t.dispatcher, {
    idempotency_key: randomUUID(),
    subject,
    to: [broker],
    channel: "sms",
    body: "ETA?",
  });
  return sent.thread_id;
};

test("a text reply lands in the conversation it answers, once, and is unread", async () => {
  const thread = await textThread("Reply by text");
  const before = (await unreadCount(t.dispatcher)).unread;
  const sid = "SM" + randomUUID();
  const ok = await smsHook({
    From: "+12145550177",
    To: "+15555550100",
    Body: "Be there at 3",
    MessageSid: sid,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/xml");
  const view = await getThread(t.dispatcher, thread);
  const last = view.messages.at(-1);
  assert.equal(last.source, "inbound");
  assert.equal(last.channel, "sms");
  assert.equal(last.direction, "in");
  assert.equal(last.body, "Be there at 3");
  assert.equal(last.sender_name, "Casey Broker");
  assert.equal((await unreadCount(t.dispatcher)).unread, before + 1);
  // The provider retrying the same message adds nothing.
  await smsHook({
    From: "+12145550177",
    To: "+15555550100",
    Body: "Be there at 3",
    MessageSid: sid,
  });
  assert.equal((await getThread(t.dispatcher, thread)).messages.length, 2);
});

test("unsigned, mis-signed and unknown-number texts are refused and store nothing", async () => {
  const thread = await textThread("Refusals");
  const count = async () =>
    (await getThread(t.dispatcher, thread)).messages.length;
  const before = await count();
  assert.equal(
    (
      await smsHook(
        { From: "+12145550177", Body: "x", MessageSid: "SM1" },
        false,
      )
    ).status,
    403,
  );
  const forged = new URLSearchParams({
    From: "+12145550177",
    Body: "x",
    MessageSid: "SM2",
  });
  const bad = await POST(
    new NextRequest("http://localhost:3000/api/webhooks/sms", {
      method: "POST",
      headers: {
        "x-twilio-signature": twilioSignature(
          "wrong",
          "https://relay.example.test/api/webhooks/sms",
          forged,
        ),
      },
      body: forged.toString(),
    }),
  );
  assert.equal(bad.status, 403);
  // A number we never texted cannot create or join a conversation.
  const stranger = await smsHook({
    From: "+12145559999",
    Body: "hello",
    MessageSid: "SM" + randomUUID(),
  });
  assert.equal(stranger.status, 200);
  assert.equal(await count(), before);
  const audits = await pool.query(
    "SELECT 1 FROM audit_logs WHERE action='inbound.sms_unmatched'",
  );
  assert.ok(audits.rowCount! >= 1);
});

test("STOP withdraws consent immediately, still threads, and blocks further texts", async () => {
  const thread = await textThread("Opt out");
  await smsHook({
    From: "+12145550177",
    Body: "STOP",
    MessageSid: "SM" + randomUUID(),
  });
  const row = await pool.query(
    "SELECT sms_consent_at FROM contacts WHERE id=$1",
    [broker.slice(8)],
  );
  assert.equal(row.rows[0].sms_consent_at, null);
  assert.equal(
    (await getThread(t.dispatcher, thread)).messages.at(-1).body,
    "STOP",
  );
  await assert.rejects(
    sendMessage(t.dispatcher, {
      idempotency_key: randomUUID(),
      thread_id: thread,
      to: [broker],
      channel: "sms",
      body: "Still there?",
    }),
    { code: "RECIPIENT_CHANNEL_UNAVAILABLE" },
  );
  const audits = await pool.query(
    "SELECT 1 FROM audit_logs WHERE action='sms.opted_out' AND resource_id=$1",
    [broker.slice(8)],
  );
  assert.equal(audits.rowCount, 1);
  await pool.query(
    "UPDATE contacts SET sms_consent_at=now(),sms_consent_by=$2 WHERE id=$1",
    [broker.slice(8), t.dispatcher],
  );
});

test("email replies route through the signed reply address and must come from a participant", async () => {
  const sent = await sendMessage(t.dispatcher, {
    idempotency_key: randomUUID(),
    subject: "Rate confirmation",
    to: [broker],
    channel: "email",
    body: "Please confirm the rate.",
  });
  const replyTo = replyAddress(sent.thread_id)!;
  assert.match(
    replyTo,
    /^reply\+[0-9a-f]{32}\.[0-9a-f]{16}@mail\.relay\.test$/,
  );
  const msg = (over: Record<string, unknown> = {}) => ({
    id: "<" + randomUUID() + "@broker.test>",
    from: "Casey Broker <Casey@Broker.test>",
    to: [replyTo],
    subject: "Re: Rate confirmation",
    text: "Confirmed at $2,500.\n\nOn Tue, Oct 21, Dispatcher wrote:\n> Please confirm the rate.\n",
    ...over,
  });
  const first = msg();
  const ok = await emailHook(first);
  assert.deepEqual(await ok.json(), { status: "stored" });
  const last = (await getThread(t.dispatcher, sent.thread_id)).messages.at(-1);
  assert.equal(last.body, "Confirmed at $2,500.");
  assert.equal(last.sender_name, "Casey Broker");
  assert.equal(last.source, "inbound");
  assert.deepEqual(await (await emailHook(first)).json(), {
    status: "duplicate",
  });
  // Forged sender, tampered token, wrong secret, missing signature.
  assert.deepEqual(
    await (await emailHook(msg({ from: "attacker@evil.test" }))).json(),
    { status: "rejected" },
  );
  assert.deepEqual(
    await (
      await emailHook(
        msg({
          to: [
            replyTo.replace(/([0-9a-f])@/, (_, last: string) =>
              last === "0" ? "1@" : "0@",
            ),
          ],
        }),
      )
    ).json(),
    { status: "unmatched" },
  );
  assert.equal((await emailHook(msg(), true, "wrong")).status, 403);
  assert.equal((await emailHook(msg(), false)).status, 403);
  assert.equal(
    (await getThread(t.dispatcher, sent.thread_id)).messages.length,
    2,
  );
  // Other tenants cannot see the reply.
  await assert.rejects(getThread(t.foreignManager, sent.thread_id), {
    code: "NOT_FOUND",
  });
});

test("webhooks are unavailable until configured", async () => {
  const keep = process.env.RELAY_INBOUND_SECRET;
  delete process.env.RELAY_INBOUND_SECRET;
  assert.equal(
    (await emailHook({ id: "x", from: "a@b.test", to: ["c@d.test"] }, false))
      .status,
    503,
  );
  process.env.RELAY_INBOUND_SECRET = keep;
});

test("quoted history is removed from replies", () => {
  assert.equal(
    stripQuoted("Yes.\n> old\nSecond line\n\nOn Mon, X <x@y> wrote:\n> more"),
    "Yes.\nSecond line",
  );
});
