import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { getThread, sendMessage } from "../../src/lib/messaging";
import { createContact } from "../../src/lib/contacts";
import { setTransport } from "../../src/lib/notifications";
import { setSmsTransport } from "../../src/lib/sms";
import { twilioSignature, replyAddress } from "../../src/lib/inbound";
import {
  attachmentContent,
  cleanupAbandoned,
  uploadAttachment,
} from "../../src/lib/message-attachments";
import { visibleThread } from "../../src/lib/messaging";
import { clamdScanner, setScanner } from "../../src/lib/malware";
import { setObjectStore } from "../../src/lib/storage";
import { eicar, startFakeClamd, startFakeS3 } from "./fakes";
import { tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
process.env.RELAY_INBOUND_SECRET = "fictional-inbound-secret";
process.env.RELAY_INBOUND_EMAIL_DOMAIN = "mail.relay.test";
process.env.RELAY_SMS_TRANSPORT = "twilio";
process.env.TWILIO_AUTH_TOKEN = "fictional-twilio-token";
process.env.TWILIO_ACCOUNT_SID = "ACfictional";
process.env.APP_ORIGIN = "https://relay.example.test";

let t: Awaited<ReturnType<typeof tenant>>;
let broker: string;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let s3: Awaited<ReturnType<typeof startFakeS3>>;
const mediaRequests: { url: string; auth: string | undefined }[] = [];
let media: ReturnType<typeof createServer>;
const pdfBytes = (label: string) =>
  Buffer.from(`%PDF-1.4\n% fictional ${label} ${randomUUID()}\n%%EOF\n`);

before(async () => {
  t = await tenant("InAtt");
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
        name: "Robin Broker",
        company: "Fictional Brokers",
        email: "robin@broker.test",
        phone: "(214) 555-0188",
        notes: "",
        carrier_id: null,
        sms_consent: true,
        sms_consent_note: "Verbal OK",
      })
    ).id;
  setSmsTransport({
    name: "t",
    send: async () => ({ ok: true, providerId: "SM1" }),
  });
  clamd = await startFakeClamd();
  s3 = await startFakeS3();
  // Stand-in for Twilio's media host: needs basic auth, serves one JPEG-less PDF.
  media = createServer((req: IncomingMessage, res) => {
    mediaRequests.push({ url: req.url!, auth: req.headers.authorization });
    const expected =
      "Basic " +
      Buffer.from("ACfictional:fictional-twilio-token").toString("base64");
    if (req.url === "/cdn/file")
      return res
        .writeHead(200, { "content-type": "application/pdf" })
        .end(pdfBytes("cdn"));
    if (req.headers.authorization !== expected) return res.writeHead(401).end();
    if (req.url === "/media/redirect")
      return res.writeHead(302, { location: "/cdn/file" }).end();
    res
      .writeHead(200, { "content-type": "application/pdf" })
      .end(pdfBytes("mms"));
  });
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${(media.address() as { port: number }).port}`;
});
after(async () => {
  setTransport(null);
  setSmsTransport(undefined);
  setScanner(undefined);
  setObjectStore(undefined);
  media.close();
  clamd.close();
  s3.close();
  await pool.end();
});

const emailThread = async (subject: string) => {
  const sent = await sendMessage(t.dispatcher, {
    idempotency_key: randomUUID(),
    subject,
    to: [broker],
    channel: "email",
    body: "Please send the rate con.",
  });
  // The reply address is derived from the thread, so no delivery is needed.
  return { thread: sent.thread_id, replyTo: replyAddress(sent.thread_id)! };
};
const emailHook = (payload: object) => {
  const raw = JSON.stringify(payload);
  return POST(
    new NextRequest("http://localhost:3000/api/webhooks/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-signature":
          "sha256=" +
          createHmac("sha256", process.env.RELAY_INBOUND_SECRET!)
            .update(raw)
            .digest("hex"),
      },
      body: raw,
    }),
  );
};
const smsHook = (fields: Record<string, string>) => {
  const params = new URLSearchParams(fields);
  return POST(
    new NextRequest("http://localhost:3000/api/webhooks/sms", {
      method: "POST",
      headers: {
        "x-twilio-signature": twilioSignature(
          process.env.TWILIO_AUTH_TOKEN!,
          "https://relay.example.test/api/webhooks/sms",
          params,
        ),
      },
      body: params.toString(),
    }),
  );
};
const b64 = (b: Buffer) => b.toString("base64");
const download = (user: string, id: string) =>
  attachmentContent(user, id, visibleThread);

test("email attachments are scanned and kept; refused ones are reported in the message", async () => {
  setScanner(clamdScanner("127.0.0.1", clamd.port, 2000));
  const { thread, replyTo } = await emailThread("Rate con");
  const good = pdfBytes("ratecon");
  const payload = {
    id: "<" + randomUUID() + "@broker.test>",
    from: "robin@broker.test",
    to: [replyTo],
    text: "Signed copy attached.",
    attachments: [
      { filename: "ratecon.pdf", content_base64: b64(good) },
      {
        filename: "setup.exe",
        content_base64: b64(Buffer.from("MZ not allowed")),
      },
      {
        filename: "bad.pdf",
        content_base64: b64(
          Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(eicar)]),
        ),
      },
    ],
  };
  assert.deepEqual(await (await emailHook(payload)).json(), {
    status: "stored",
  });
  const last = (await getThread(t.dispatcher, thread)).messages.at(-1);
  assert.equal(last.source, "inbound");
  assert.equal(last.attachments.length, 1);
  assert.equal(last.attachments[0].filename, "ratecon.pdf");
  assert.match(last.body, /Signed copy attached\./);
  assert.match(
    last.body,
    /2 attachments not saved: unsupported type.*; blocked by the virus scan/,
  );
  const file = await download(t.dispatcher, last.attachments[0].id);
  assert.equal(file.kind, "inline");
  if (file.kind === "inline") assert.deepEqual(file.content, good);
  await assert.rejects(download(t.foreignManager, last.attachments[0].id), {
    code: "NOT_FOUND",
  });
  // A retry of the same email adds neither a message nor a file.
  assert.deepEqual(await (await emailHook(payload)).json(), {
    status: "duplicate",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM message_attachments WHERE message_id=$1",
        [last.id],
      )
    ).rows[0].n,
    1,
  );
  // The file cannot be re-linked or deleted while attached.
  await assert.rejects(
    pool.query("DELETE FROM message_attachments WHERE message_id=$1", [
      last.id,
    ]),
  );
  setScanner(undefined);
});

test("an email with only a file still lands, and more than three files are capped", async () => {
  const { thread, replyTo } = await emailThread("Only file");
  const files = Array.from({ length: 5 }, (_, i) => ({
    filename: `p${i}.pdf`,
    content_base64: b64(pdfBytes("many" + i)),
  }));
  await emailHook({
    id: randomUUID(),
    from: "robin@broker.test",
    to: [replyTo],
    text: "",
    attachments: files,
  });
  const last = (await getThread(t.dispatcher, thread)).messages.at(-1);
  assert.equal(last.attachments.length, 3);
  assert.match(last.body, /^\(attachment only\)/);
  assert.match(last.body, /more than 3 files/);
});

test("MMS pictures are fetched only from the configured Twilio host, with credentials", async () => {
  const sent = await sendMessage(t.dispatcher, {
    idempotency_key: randomUUID(),
    subject: "MMS",
    to: [broker],
    channel: "sms",
    body: "Photo of the BOL?",
  });
  mediaRequests.length = 0;
  const base = process.env.TWILIO_API_BASE!;
  const ok = await smsHook({
    From: "+12145550188",
    Body: "",
    MessageSid: "MM" + randomUUID(),
    NumMedia: "3",
    MediaUrl0: base + "/media/one",
    MediaUrl1: base + "/media/redirect",
    MediaUrl2: "http://169.254.169.254/latest/meta-data", // not Twilio: never fetched
  });
  assert.equal(ok.status, 200);
  const last = (await getThread(t.dispatcher, sent.thread_id)).messages.at(-1);
  assert.equal(last.channel, "sms");
  assert.equal(last.attachments.length, 2);
  assert.match(last.body, /1 attachment not saved: could not be saved/);
  assert.ok(
    mediaRequests
      .filter((r) => r.url !== "/cdn/file")
      .every((r) => r.auth?.startsWith("Basic ")),
  );
  // The redirect target is fetched too, but without our credentials.
  const redirected = mediaRequests.find((r) => r.url === "/cdn/file");
  assert.ok(redirected);
  assert.equal(redirected!.auth, undefined);
  assert.ok(!mediaRequests.some((r) => r.url.includes("meta-data")));
});

test("abandoned uploads are removed after a day; attached and recent files are kept", async () => {
  setObjectStore(s3.client());
  const old = await uploadAttachment(t.dispatcher, {
    name: "old.pdf",
    bytes: pdfBytes("old"),
  });
  const fresh = await uploadAttachment(t.dispatcher, {
    name: "fresh.pdf",
    bytes: pdfBytes("fresh"),
  });
  const used = await uploadAttachment(t.dispatcher, {
    name: "used.pdf",
    bytes: pdfBytes("used"),
  });
  await pool.query(
    "UPDATE message_attachments SET created_at=now()-interval '2 days' WHERE id=$1",
    [used.id],
  );
  await sendMessage(t.dispatcher, {
    idempotency_key: randomUUID(),
    subject: "Keep",
    to: ["user:" + t.manager],
    channel: "in_app",
    body: "With file",
    attachment_ids: [used.id],
  });
  await pool.query(
    "UPDATE message_attachments SET created_at=now()-interval '2 days' WHERE id=$1",
    [old.id],
  );
  const keyOf = async (id: string) =>
    (
      await pool.query(
        "SELECT storage_key FROM message_attachments WHERE id=$1",
        [id],
      )
    ).rows[0].storage_key as string;
  const [oldKey, usedKey, freshKey] = [
    await keyOf(old.id),
    await keyOf(used.id),
    await keyOf(fresh.id),
  ];
  const has = (key: string) =>
    [...s3.objects.keys()].some((k) => k.endsWith("/" + key));
  assert.ok(has(oldKey) && has(usedKey) && has(freshKey));
  // Storage outage: nothing is deleted from the database either; the next run retries.
  s3.state.down = true;
  const failed = await cleanupAbandoned();
  s3.state.down = false;
  assert.ok(failed.failed >= 1);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM message_attachments WHERE id=$1", [
        old.id,
      ])
    ).rowCount,
    1,
  );
  const done = await cleanupAbandoned();
  assert.ok(done.attachments >= 1);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM message_attachments WHERE id=$1", [
        old.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM document_objects WHERE storage_key=$1", [
        oldKey,
      ])
    ).rowCount,
    0,
  );
  assert.ok(!has(oldKey));
  assert.ok(has(usedKey) && has(freshKey));
  assert.equal(
    (
      await pool.query("SELECT 1 FROM message_attachments WHERE id=ANY($1)", [
        [used.id, fresh.id],
      ])
    ).rowCount,
    2,
  );
  await assert.rejects(download(t.dispatcher, old.id), { code: "NOT_FOUND" });
  const audit = await pool.query(
    "SELECT 1 FROM audit_logs WHERE action='message_attachment.abandoned_removed' AND resource_id=$1",
    [old.id],
  );
  assert.equal(audit.rowCount, 1);
  // Running again changes nothing.
  assert.equal((await cleanupAbandoned()).attachments, 0);
});

test("expired direct-upload reservations lose their quarantine object and are closed", async () => {
  const client = s3.client();
  setObjectStore(client);
  const key = `quarantine/${randomUUID()}`;
  await client.put(key, Buffer.from("%PDF-1.4 half uploaded"), "a".repeat(64));
  const live = `quarantine/${randomUUID()}`;
  await client.put(live, Buffer.from("%PDF-1.4 in progress"), "b".repeat(64));
  const make = async (quarantine: string, expiresAgo: string) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO document_upload_sessions(id,actor_id,carrier_id,type,filename,size_bytes,sha256,bucket,quarantine_key,expires_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,'bol','x.pdf',5000000,$4,$5,$6,now()-$7::interval,$8,'h')`,
      [
        id,
        t.dispatcher,
        t.carrier,
        "c".repeat(64),
        client.bucket,
        quarantine,
        expiresAgo,
        randomUUID(),
      ],
    );
    return id;
  };
  const dead = await make(key, "3 hours");
  const waiting = await make(live, "10 minutes"); // inside the grace period
  const result = await cleanupAbandoned();
  assert.ok(result.upload_sessions >= 1);
  const status = async (id: string) =>
    (
      await pool.query(
        "SELECT status,failure FROM document_upload_sessions WHERE id=$1",
        [id],
      )
    ).rows[0];
  assert.deepEqual(await status(dead), {
    status: "rejected",
    failure: "UPLOAD_EXPIRED",
  });
  assert.equal((await status(waiting)).status, "pending");
  const keys = [...s3.objects.keys()];
  assert.ok(!keys.some((k) => k.endsWith(key)));
  assert.ok(keys.some((k) => k.endsWith(live)));
  setObjectStore(undefined);
});
