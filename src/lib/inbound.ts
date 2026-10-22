import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError, digest } from "./auth";
import { appOrigin, enqueueForUser } from "./notifications";
import { toE164 } from "./sms";
import {
  recordInbound,
  scanAndStore,
  type StoredFile,
} from "./message-attachments";
import { maxDocumentBytes } from "./compliance";

const maxInboundFiles = 3;
type Prepared = { files: StoredFile[]; skipped: string[] };

/** Scans and stores each candidate; anything refused is reported, not fatal. */
async function prepare(
  externalId: string,
  candidates: { name: string; load: () => Promise<Buffer> }[],
): Promise<Prepared> {
  const out: Prepared = { files: [], skipped: [] };
  const base = digest(externalId);
  for (const [i, candidate] of candidates.slice(0, maxInboundFiles).entries()) {
    try {
      out.files.push(
        await scanAndStore(
          null,
          await candidate.load(),
          candidate.name,
          // Deterministic, so a provider retry reuses the same write-once key.
          `message-attachments/inbound/${base}/${i}`,
        ),
      );
    } catch (e) {
      out.skipped.push(
        e instanceof HttpError && e.code === "MALWARE_DETECTED"
          ? "blocked by the virus scan"
          : e instanceof HttpError && e.code === "UNSUPPORTED_FILE_TYPE"
            ? "unsupported type (only PDF, PNG and JPEG are kept)"
            : e instanceof HttpError && e.code === "FILE_TOO_LARGE"
              ? "larger than 4 MB"
              : "could not be saved",
      );
    }
  }
  if (candidates.length > maxInboundFiles)
    out.skipped.push(`more than ${maxInboundFiles} files`);
  return out;
}
const withNotice = (body: string, p: Prepared) => {
  const text = body || (p.files.length ? "(attachment only)" : "");
  return p.skipped.length
    ? `${text}\n\n[${p.skipped.length} attachment${p.skipped.length === 1 ? "" : "s"} not saved: ${[...new Set(p.skipped)].join("; ")}]`.slice(
        0,
        5000,
      )
    : text;
};
const alreadyStored = async (channel: string, externalId: string) =>
  Boolean(
    (
      await pool.query(
        "SELECT 1 FROM messages WHERE channel=$1 AND external_id=$2",
        [channel, externalId],
      )
    ).rowCount,
  );

/**
 * Twilio media URLs are fetched only from the configured Twilio API host,
 * with the account credentials, and the one redirect Twilio issues to its CDN
 * is followed without them. Anything else is refused (no arbitrary fetches).
 */
async function fetchTwilioMedia(url: string): Promise<Buffer> {
  const sid = process.env.TWILIO_ACCOUNT_SID,
    token = process.env.TWILIO_AUTH_TOKEN;
  const base = new URL(process.env.TWILIO_API_BASE || "https://api.twilio.com");
  const target = new URL(url);
  if (!sid || !token || target.origin !== base.origin)
    throw new HttpError(422, "MEDIA_REFUSED");
  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const read = async (response: Response) => {
    if (!response.ok) throw new HttpError(502, "MEDIA_UNAVAILABLE");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxDocumentBytes) throw new HttpError(413, "FILE_TOO_LARGE");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxDocumentBytes)
      throw new HttpError(413, "FILE_TOO_LARGE");
    return bytes;
  };
  const first = await fetch(target, {
    headers: { Authorization: auth },
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (first.status >= 300 && first.status < 400) {
    const next = new URL(first.headers.get("location") || "", target);
    if (next.protocol !== "https:" && next.origin !== base.origin)
      throw new HttpError(422, "MEDIA_REFUSED");
    return read(await fetch(next, { signal: AbortSignal.timeout(10000) }));
  }
  return read(first);
}

// Inbound email and text (ADR 0023). Providers call a signed webhook; a
// message is accepted only when it can be tied to a conversation that Relay
// itself started, so strangers cannot create records.

const secret = () => process.env.RELAY_INBOUND_SECRET || null;
export const inboundDomain = () =>
  process.env.RELAY_INBOUND_EMAIL_DOMAIN || null;

const equalHex = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const mac = (purpose: string, value: string, key: string) =>
  createHmac("sha256", key)
    .update(purpose + ":" + value)
    .digest("hex");

// ---------- Reply addresses ----------

/**
 * `reply+<thread>.<mac>@domain` for outgoing email, so a reply lands in the
 * same conversation. Null (use the sender's own address) unless inbound mail is
 * configured.
 */
export function replyAddress(threadId: string): string | null {
  const key = secret(),
    domain = inboundDomain();
  if (!key || !domain) return null;
  const id = threadId.replaceAll("-", "");
  return `reply+${id}.${mac("thread", id, key).slice(0, 16)}@${domain}`;
}
function threadFromAddress(address: string): string | null {
  const key = secret();
  const match = /^reply\+([0-9a-f]{32})\.([0-9a-f]{16})@/i.exec(address.trim());
  if (!key || !match) return null;
  const id = match[1].toLowerCase();
  if (!equalHex(mac("thread", id, key).slice(0, 16), match[2].toLowerCase()))
    return null;
  return [
    id.slice(0, 8),
    id.slice(8, 12),
    id.slice(12, 16),
    id.slice(16, 20),
    id.slice(20),
  ].join("-");
}

// ---------- Shared ----------

const audit = (action: string, resource: string) =>
  pool
    .query("INSERT INTO audit_logs VALUES($1,NULL,$2,$3,now())", [
      randomUUID(),
      action,
      resource,
    ])
    .catch(() => console.error("inbound.audit_unavailable"));

/** Drops quoted history so threads hold what the person actually wrote. */
export function stripQuoted(text: string) {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (
      /^On .{5,200} wrote:\s*$/.test(line) ||
      /^-{2,}\s*Original Message/i.test(line)
    )
      break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim().slice(0, 5000);
}

async function store(
  threadId: string,
  channel: "email" | "sms",
  externalId: string,
  label: string,
  body: string,
  notifyOrigin: string,
  files: StoredFile[] = [],
) {
  return transaction(async (c) => {
    const thread = (
      await c.query("SELECT * FROM threads WHERE id=$1 FOR UPDATE", [threadId])
    ).rows[0];
    if (!thread) return "unmatched" as const;
    const id = randomUUID();
    const inserted = await c.query(
      `INSERT INTO messages(id,thread_id,sender_user_id,channel,direction,source,body,counterpart,sender_label,occurred_at,idempotency_key,request_hash,external_id)
      VALUES($1,$2,NULL,$3,'in','inbound',$4,$5,$5,now(),$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        id,
        threadId,
        channel,
        body,
        label.slice(0, 160),
        randomUUID(),
        digest(externalId),
        externalId,
      ],
    );
    if (!inserted.rowCount) return "duplicate" as const;
    await recordInbound(c, id, files);
    await c.query("UPDATE threads SET last_message_at=now() WHERE id=$1", [
      threadId,
    ]);
    const people = await c.query(
      "SELECT DISTINCT user_id FROM thread_participants WHERE thread_id=$1 AND user_id IS NOT NULL",
      [threadId],
    );
    for (const p of people.rows)
      await enqueueForUser(c, p.user_id, {
        kind: "message_received",
        organization: thread.organization_id,
        dedupe: `message_received:${id}:${p.user_id}`,
        subject:
          `${channel === "sms" ? "Text" : "Email"} reply from ${label}: ${thread.subject}`.slice(
            0,
            200,
          ),
        text: `${label} replied by ${channel === "sms" ? "text" : "email"} to “${thread.subject}”.\n\nOpen your inbox: ${notifyOrigin}`,
      });
    await c.query("INSERT INTO audit_logs VALUES($1,NULL,$2,$3,now())", [
      randomUUID(),
      "message.received." + channel,
      id,
    ]);
    return "stored" as const;
  });
}

// ---------- Text messages (Twilio) ----------

/**
 * Twilio signs `url + sorted(name + value)` with the account auth token
 * (HMAC-SHA1, base64). `url` must be the public address Twilio was given.
 */
export function twilioSignature(
  token: string,
  url: string,
  params: URLSearchParams,
) {
  const keys = [...new Set([...params.keys()])].sort();
  const data = keys.reduce((s, k) => s + k + params.getAll(k).join(""), url);
  return createHmac("sha1", token).update(data).digest("base64");
}
const stopWords = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);
const last10 = (e164: string) => e164.replace(/\D/g, "").slice(-10);

export async function receiveSms(
  rawBody: string,
  signature: string | null,
  url: string,
) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || process.env.RELAY_SMS_TRANSPORT !== "twilio")
    throw new HttpError(503, "INBOUND_UNAVAILABLE");
  const params = new URLSearchParams(rawBody);
  const expected = twilioSignature(token, url, params);
  if (!signature || !equalHex(expected, signature)) {
    await audit("inbound.sms_rejected", "bad signature");
    throw new HttpError(403, "BAD_SIGNATURE");
  }
  const from = toE164(params.get("From") || "");
  const sid = params.get("MessageSid") || "";
  const body = (params.get("Body") || "").trim();
  const mediaCount = Math.min(Number(params.get("NumMedia") || 0) || 0, 10);
  if (!from || !sid || (!body && !mediaCount)) return { status: "ignored" };
  const opted = stopWords.has(body.toLowerCase().replace(/[^a-z]/g, ""));
  const digits = last10(from);
  if (opted) {
    // Carriers expect STOP to end texting immediately, whatever else happens.
    const users = await pool.query(
      "UPDATE users SET sms_opt_in_at=NULL WHERE sms_opt_in_at IS NOT NULL AND right(regexp_replace(phone,'\\D','','g'),10)=$1 RETURNING id",
      [digits],
    );
    const contacts = await pool.query(
      "UPDATE contacts SET sms_consent_at=NULL,sms_consent_by=NULL,version=version+1 WHERE sms_consent_at IS NOT NULL AND right(regexp_replace(phone,'\\D','','g'),10)=$1 RETURNING id",
      [digits],
    );
    for (const r of [...users.rows, ...contacts.rows])
      await audit("sms.opted_out", r.id);
  }
  // Thread it with the conversation we last texted this number from.
  const recent = (
    await pool.query(
      `SELECT m.thread_id,p.name FROM message_deliveries d JOIN messages m ON m.id=d.message_id
      LEFT JOIN thread_participants p ON p.thread_id=m.thread_id AND p.participant_key=d.participant_key
      WHERE d.channel='sms' AND d.address=$1 AND m.created_at>now()-interval '30 days'
      ORDER BY m.created_at DESC LIMIT 1`,
      [from],
    )
  ).rows[0];
  if (!recent) {
    await audit("inbound.sms_unmatched", "no recent conversation");
    return { status: opted ? "opted_out" : "unmatched" };
  }
  if (await alreadyStored("sms", sid)) return { status: "duplicate" };
  const media = await prepare(
    sid,
    Array.from({ length: mediaCount }, (_, i) => ({
      name: "text-attachment-" + (i + 1),
      load: () => fetchTwilioMedia(params.get("MediaUrl" + i) || ""),
    })),
  );
  const outcome = await store(
    recent.thread_id,
    "sms",
    sid,
    recent.name || from,
    withNotice(body, media),
    appOrigin(),
    media.files,
  );
  return { status: opted ? "opted_out" : outcome };
}

// ---------- Email ----------

export const inboundEmailSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    from: z.string().trim().min(3).max(320),
    to: z.array(z.string().trim().max(320)).min(1).max(20),
    subject: z.string().max(500).default(""),
    text: z.string().max(100000).default(""),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().max(200).default("attachment"),
            content_base64: z
              .string()
              .max(Math.ceil((maxDocumentBytes * 4) / 3) + 8),
          })
          .strict(),
      )
      .max(6)
      .default([]),
  })
  .strict();

const bareAddress = (value: string) =>
  (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();

/**
 * Accepts a JSON email signed with `x-relay-signature: sha256=<hmac>` over the
 * raw body. Adapters for a given provider (Resend, Postmark, SendGrid) only
 * need to forward these fields.
 */
export async function receiveEmail(rawBody: string, signature: string | null) {
  const key = secret();
  if (!key || !inboundDomain()) throw new HttpError(503, "INBOUND_UNAVAILABLE");
  const expected =
    "sha256=" + createHmac("sha256", key).update(rawBody).digest("hex");
  if (!signature || !equalHex(expected, signature)) {
    await audit("inbound.email_rejected", "bad signature");
    throw new HttpError(403, "BAD_SIGNATURE");
  }
  const mail = inboundEmailSchema.parse(JSON.parse(rawBody));
  const threadId = mail.to.map(threadFromAddress).find(Boolean) ?? null;
  const from = bareAddress(mail.from);
  const body = stripQuoted(mail.text);
  if (!threadId || (!body && !mail.attachments.length)) {
    await audit("inbound.email_unmatched", "no valid reply address");
    return { status: "unmatched" };
  }
  // The sender must be someone already in the conversation: From can be forged,
  // so an unknown address never writes into a thread.
  const person = (
    await pool.query(
      "SELECT name FROM thread_participants WHERE thread_id=$1 AND lower(email)=$2 LIMIT 1",
      [threadId, from],
    )
  ).rows[0];
  if (!person) {
    await audit("inbound.email_sender_rejected", threadId);
    return { status: "rejected" };
  }
  if (await alreadyStored("email", mail.id)) return { status: "duplicate" };
  const media = await prepare(
    mail.id,
    mail.attachments.map((a) => ({
      name: a.filename,
      load: async () => Buffer.from(a.content_base64, "base64"),
    })),
  );
  return {
    status: await store(
      threadId,
      "email",
      mail.id,
      person.name,
      withNotice(body, media),
      appOrigin(),
      media.files,
    ),
  };
}
