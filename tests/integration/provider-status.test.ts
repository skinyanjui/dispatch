import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { getThread, sendMessage } from "../../src/lib/messaging";
import { notificationLog } from "../../src/lib/notifications";
import { receiveEmailStatus } from "../../src/lib/provider-receipts";
import { request, sessionFor, tenant } from "./fixtures";
after(() => pool.end());

test("signed SMS delivery receipts deduplicate, retain audit scope and cannot regress a confirmed delivery", async () => {
  const t = await tenant("ReceiptSMS");
  const made = await sendMessage(t.dispatcher, {
    to: ["user:" + t.driverUser],
    channel: "in_app",
    body: "Fictional QA",
    subject: "Fictional",
    idempotency_key: randomUUID(),
  });
  const d = (
    await pool.query("SELECT id FROM message_deliveries WHERE message_id=$1", [
      made.message_id,
    ])
  ).rows[0];
  const sid = "SM" + randomUUID().replaceAll("-", "");
  await pool.query(
    "UPDATE message_deliveries SET channel='sms',status='sent',provider_message_id=$2 WHERE id=$1",
    [d.id, sid],
  );
  const secret = randomBytes(24).toString("hex");
  process.env.TWILIO_AUTH_TOKEN = secret;
  delete process.env.APP_ORIGIN;
  const callback = async (status: string, good = true) => {
    const raw = new URLSearchParams({
      MessageSid: sid,
      MessageStatus: status,
    }).toString();
    const url = "http://localhost:3000/api/webhooks/sms-status";
    const signature = createHmac("sha1", secret)
      .update(url + "MessageSid" + sid + "MessageStatus" + status)
      .digest("base64");
    return POST(
      request("webhooks/sms-status", {
        body: raw,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": good ? signature : "bad",
        },
      }),
    );
  };
  assert.equal((await callback("delivered", false)).status, 403);
  assert.equal((await callback("delivered")).status, 204);
  assert.equal((await callback("delivered")).status, 204);
  await callback("sent");
  await callback("failed");
  assert.equal(
    (await getThread(t.dispatcher, made.thread_id)).messages[0].deliveries[0]
      .status,
    "delivered",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM provider_receipts WHERE provider_message_id=$1 AND status='delivered'",
        [sid],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_logs WHERE resource_id=$1 AND action='message.delivery_confirmed' AND organization_id=$2",
        [d.id, t.organization],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    pool.query(
      "UPDATE provider_receipts SET status='failed' WHERE provider_message_id=$1",
      [sid],
    ),
  );
  // A receipt from an earlier attempt never changes the current attempt.
  await pool.query(
    "UPDATE message_deliveries SET status='sent',provider_message_id=$2 WHERE id=$1",
    [d.id, "SM" + randomUUID().replaceAll("-", "")],
  );
  assert.equal(
    (await getThread(t.dispatcher, made.thread_id)).messages[0].deliveries[0]
      .status,
    "sent",
  );
});

test("Resend native signatures reject tampering and old requests; early receipts reconcile after provider acceptance", async () => {
  const t = await tenant("ReceiptEmail");
  const key = randomBytes(32);
  process.env.RESEND_WEBHOOK_SECRET = "whsec_" + key.toString("base64");
  const id = randomUUID(),
    event = "evt_" + randomUUID();
  const raw = JSON.stringify({
    type: "email.delivered",
    data: { email_id: id },
  });
  const signed = (seconds = Math.floor(Date.now() / 1000), payload = raw) =>
    new Headers({
      "svix-id": event,
      "svix-timestamp": String(seconds),
      "svix-signature":
        "v1," +
        createHmac("sha256", key)
          .update(event + "." + seconds + "." + payload)
          .digest("base64"),
    });
  await assert.rejects(receiveEmailStatus(raw + " ", signed()), {
    code: "INVALID_WEBHOOK_SIGNATURE",
  });
  await assert.rejects(
    receiveEmailStatus(raw, signed(Math.floor(Date.now() / 1000) - 1000)),
    { code: "INVALID_WEBHOOK_SIGNATURE" },
  );
  // Callback wins the race with the worker writing provider_message_id.
  assert.equal((await receiveEmailStatus(raw, signed())).status, "recorded");
  assert.equal((await receiveEmailStatus(raw, signed())).status, "duplicate");
  await pool.query(
    "INSERT INTO notifications(id,organization_id,recipient_email,kind,subject,dedupe_key,status,provider,provider_message_id) VALUES(gen_random_uuid(),$1,'fictional@relay.test','assignment','Fictional',$2,'sent','resend',$3)",
    [t.organization, randomUUID(), id],
  );
  const log = await notificationLog(t.dispatcher);
  assert.equal(
    log.notifications.find((n) => n.provider === "resend")!.status,
    "delivered",
  );
  const token = await sessionFor(t.foreignManager);
  const foreign = await GET(request("notifications", { token }));
  assert.equal(foreign.status, 200);
  assert.ok(!(await foreign.text()).includes(id));
});

test("a signed per-attempt SMS callback reconciles a provider timeout without another send", async () => {
  const t = await tenant("ReceiptTimeout");
  const { createContact } = await import("../../src/lib/contacts");
  const { setSmsTransport } = await import("../../src/lib/sms");
  const { receiveSmsStatus } = await import("../../src/lib/provider-receipts");
  const contact = await createContact(t.manager, {
    idempotency_key: randomUUID(),
    carrier_id: t.carrier,
    kind: "broker",
    name: "Fictional timeout receiver",
    phone: "+12145550112",
    sms_consent: true,
    sms_consent_note: "Fictional consent",
  });
  const sid = "SM" + randomUUID().replaceAll("-", ""),
    secret = randomBytes(24).toString("hex");
  process.env.TWILIO_AUTH_TOKEN = secret;
  let calls = 0;
  setSmsTransport({
    name: "fixture",
    send: async (_to, _body, reference) => {
      calls++;
      assert.ok(reference);
      const url = `http://localhost:3000/api/webhooks/sms-status?delivery_id=${reference.id}&attempt=${reference.attempt}`;
      const raw = new URLSearchParams({
        MessageSid: sid,
        MessageStatus: "delivered",
      }).toString();
      const signature = createHmac("sha1", secret)
        .update(url + "MessageSid" + sid + "MessageStatusdelivered")
        .digest("base64");
      await receiveSmsStatus(raw, signature, url);
      return {
        ok: false,
        definite: false,
        error: "Fictional lost provider response",
      };
    },
  });
  try {
    const input = {
      mode: "send",
      channel: "sms",
      to: ["contact:" + contact.id],
      subject: "QA",
      body: "Fictional timeout test",
      idempotency_key: randomUUID(),
    };
    assert.equal(
      (await sendMessage(t.manager, input)).processingState,
      "delivered",
    );
    assert.equal(
      (await sendMessage(t.manager, input)).processingState,
      "delivered",
    );
    assert.equal(calls, 1);
  } finally {
    setSmsTransport(undefined);
  }
});
