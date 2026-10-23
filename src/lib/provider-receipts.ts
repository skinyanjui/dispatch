import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { twilioSignature } from "./twilio-signature";

const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** A delivery confirmation outranks older acceptance/failure callbacks. */
export const receiptStatus = (
  kind: "notification" | "delivery",
  alias: string,
) => `CASE
  WHEN EXISTS(SELECT 1 FROM provider_receipts receipt WHERE receipt.provider='${kind === "notification" ? "resend" : "twilio"}' AND receipt.provider_message_id=${alias}.provider_message_id AND (receipt.${kind}_id=${alias}.id OR (receipt.notification_id IS NULL AND receipt.delivery_id IS NULL)) AND receipt.status='delivered') THEN 'delivered'
  WHEN EXISTS(SELECT 1 FROM provider_receipts receipt WHERE receipt.provider='${kind === "notification" ? "resend" : "twilio"}' AND receipt.provider_message_id=${alias}.provider_message_id AND (receipt.${kind}_id=${alias}.id OR (receipt.notification_id IS NULL AND receipt.delivery_id IS NULL)) AND receipt.status='failed') THEN 'failed'
  ELSE ${alias}.status END`;

async function store(
  provider: "twilio" | "resend",
  eventId: string,
  providerId: string,
  status: "delivered" | "failed",
  reference?: { id: string; attempt: number },
) {
  return transaction(async (c) => {
    const kind = provider === "twilio" ? "delivery" : "notification";
    const matches = await c.query(
      provider === "twilio"
        ? "SELECT d.id,t.organization_id FROM message_deliveries d JOIN messages m ON m.id=d.message_id JOIN threads t ON t.id=m.thread_id WHERE d.provider_message_id=$1 AND d.channel='sms' FOR UPDATE OF d"
        : "SELECT id,organization_id FROM notifications WHERE provider_message_id=$1 AND provider='resend' FOR UPDATE",
      [providerId],
    );
    if (!matches.rowCount && provider === "twilio" && reference) {
      const referenced = await c.query(
        "SELECT d.id,t.organization_id FROM message_deliveries d JOIN messages m ON m.id=d.message_id JOIN threads t ON t.id=m.thread_id WHERE d.id=$1 AND d.channel='sms' AND d.attempts=$2 AND d.provider_message_id IS NULL FOR UPDATE OF d",
        [reference.id, reference.attempt],
      );
      if (referenced.rows[0]) {
        await c.query(
          "UPDATE message_deliveries SET provider_message_id=$2 WHERE id=$1",
          [reference.id, providerId],
        );
        matches.rows = referenced.rows;
        matches.rowCount = 1;
      }
    }
    if ((matches.rowCount ?? 0) > 1)
      throw new HttpError(409, "PROVIDER_REFERENCE_AMBIGUOUS");
    const inserted = await c.query(
      `INSERT INTO provider_receipts(id,provider,event_id,provider_message_id,status,${kind}_id) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) ON CONFLICT(provider,event_id) DO NOTHING RETURNING id`,
      [provider, eventId, providerId, status, matches.rows[0]?.id ?? null],
    );
    if (inserted.rowCount && matches.rows[0])
      await c.query(
        "INSERT INTO audit_logs(id,actor_id,action,resource_id,organization_id) VALUES(gen_random_uuid(),NULL,$1,$2,$3)",
        [
          status === "delivered"
            ? "message.delivery_confirmed"
            : "message.delivery_failed",
          matches.rows[0].id,
          matches.rows[0].organization_id,
        ],
      );
    return { status: inserted.rowCount ? "recorded" : "duplicate" };
  });
}

export async function receiveSmsStatus(
  raw: string,
  signature: string | null,
  url: string,
) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED");
  const params = new URLSearchParams(raw);
  if (!signature || !equal(twilioSignature(token, url, params), signature))
    throw new HttpError(403, "INVALID_WEBHOOK_SIGNATURE");
  const id = z.string().min(1).max(100).parse(params.get("MessageSid"));
  const status = params.get("MessageStatus");
  if (!["delivered", "failed", "undelivered"].includes(status ?? ""))
    return { status: "ignored" };
  const callback = new URL(url);
  const reference = callback.searchParams.has("delivery_id")
    ? {
        id: z.uuid().parse(callback.searchParams.get("delivery_id")),
        attempt: z.coerce
          .number()
          .int()
          .positive()
          .parse(callback.searchParams.get("attempt")),
      }
    : undefined;
  return store(
    "twilio",
    digest(id + ":" + status),
    id,
    status === "delivered" ? "delivered" : "failed",
    reference,
  );
}

/** Resend's native Svix signature, including bounded timestamp and event ID. */
export async function receiveEmailStatus(raw: string, headers: Headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED");
  const id = headers.get("svix-id") ?? "",
    timestamp = headers.get("svix-timestamp") ?? "",
    signed = headers.get("svix-signature") ?? "";
  const seconds = Number(timestamp);
  if (
    !id ||
    id.length > 200 ||
    !/^\d+$/.test(timestamp) ||
    !Number.isFinite(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > 300
  )
    throw new HttpError(403, "INVALID_WEBHOOK_SIGNATURE");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length < 16) throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED");
  const signature = createHmac("sha256", key)
    .update(id + "." + timestamp + "." + raw)
    .digest("base64");
  if (
    !signed
      .split(/\s+/)
      .some((v) => v.startsWith("v1,") && equal(v.slice(3), signature))
  )
    throw new HttpError(403, "INVALID_WEBHOOK_SIGNATURE");
  const payload = z
    .object({
      type: z.string(),
      data: z.object({ email_id: z.string().min(1).max(100) }),
    })
    .parse(JSON.parse(raw));
  const status =
    payload.type === "email.delivered"
      ? "delivered"
      : ["email.bounced", "email.complained", "email.failed"].includes(
            payload.type,
          )
        ? "failed"
        : null;
  return status
    ? store("resend", id, payload.data.email_id, status)
    : { status: "ignored" };
}
