import { receiptStatus } from "./provider-receipts";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError } from "./auth";
import { decrypt, encrypt } from "./secrets";
import {
  optionalKinds,
  type NotificationKind,
  type OptionalKind,
} from "./notification-kinds";

// ---------- Transport ----------

export type Email = {
  id: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
};
export class PermanentDeliveryError extends Error {}
export type Transport = {
  name: string;
  /** Returns the provider's message id. Throw PermanentDeliveryError for
   *  rejections that retrying cannot fix. */
  send(email: Email): Promise<string | null>;
};

/** Development transport: records that a message was produced, without its
 *  body (which may contain private links). Nothing leaves the server. */
const logTransport: Transport = {
  name: "log",
  async send(email) {
    console.info("notification.logged", {
      id: email.id,
      kind_subject: email.subject,
    });
    return null;
  },
};
/** Resend's HTTP API. Used only when explicitly configured. */
function resendTransport(apiKey: string, from: string): Transport {
  return {
    name: "resend",
    async send(email) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          // The provider deduplicates retries of the same notification.
          "Idempotency-Key": email.id,
        },
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok)
        return ((await response.json()) as { id?: string }).id ?? null;
      const message = `Provider responded ${response.status}`;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        throw new PermanentDeliveryError(message);
      throw new Error(message);
    },
  };
}
let override: Transport | null = null;
/** Tests inject a transport; production reads configuration. */
export function setTransport(transport: Transport | null) {
  override = transport;
}
export function configuredTransport(): Transport | null {
  if (override) return override;
  const kind = process.env.RELAY_EMAIL_TRANSPORT || "none";
  if (kind === "log") return logTransport;
  if (kind === "resend") {
    const apiKey = process.env.RESEND_API_KEY,
      from = process.env.RELAY_EMAIL_FROM;
    if (!apiKey || !from) return null;
    return resendTransport(apiKey, from);
  }
  return null;
}

// ---------- Enqueue (inside the caller's transaction) ----------

export type Message = {
  kind: NotificationKind;
  organization: string | null;
  dedupe: string;
  subject: string;
  text: string;
  replyTo?: string;
};
async function insert(
  c: PoolClient,
  message: Message,
  recipient: { id: string | null; email: string },
): Promise<string> {
  const sealed = encrypt(message.text);
  const id = randomUUID();
  // Without an encryption key the message is recorded as suppressed so the
  // gap is visible in the delivery log instead of silently dropped.
  const inserted = await c.query(
    `INSERT INTO notifications(id,organization_id,recipient_user_id,recipient_email,kind,subject,body_ciphertext,dedupe_key,status,last_error,reply_to)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    [
      id,
      message.organization,
      recipient.id,
      recipient.email,
      message.kind,
      message.subject.slice(0, 200),
      sealed,
      message.dedupe,
      sealed ? "pending" : "suppressed",
      sealed ? null : "RELAY_DATA_KEY is not configured",
      message.replyTo ?? null,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id as string;
  const existing = await c.query(
    "SELECT id FROM notifications WHERE dedupe_key=$1",
    [message.dedupe],
  );
  return existing.rows[0].id as string;
}
export async function enqueueForEmail(
  c: PoolClient,
  email: string,
  message: Message,
) {
  return insert(c, message, { id: null, email });
}
export async function enqueueForUser(
  c: PoolClient,
  user: string,
  message: Message,
) {
  const { rows } = await c.query("SELECT email FROM users WHERE id=$1", [user]);
  return rows[0]
    ? insert(c, message, { id: user, email: rows[0].email })
    : null;
}
/**
 * The origin used in links we email and in provider callbacks. In production
 * it never comes from the request: a forged Host and Origin pair on a public
 * endpoint (password reset) would otherwise put an attacker's address in a
 * link sent to the victim. Set APP_ORIGIN; on Vercel the platform's own
 * production or deployment host is the fallback.
 */
export function appOrigin(requestOrigin?: string) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  if (process.env.NODE_ENV === "production") {
    const host =
      process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (host) return "https://" + host;
  }
  return requestOrigin || "http://localhost:3000";
}

// ---------- Delivery ----------

const backoffMinutes = [1, 5, 15, 60, 240];
export const maxAttempts = backoffMinutes.length + 1;

/** Claims due messages with SKIP LOCKED so concurrent workers never send the
 *  same row; a crashed worker's claim expires after two minutes. */
export async function deliverDue(limit = 20) {
  const transport = configuredTransport();
  const claimed = await pool.query(
    `UPDATE notifications SET locked_until=now()+interval '2 minutes'
    WHERE id IN (SELECT id FROM notifications WHERE status='pending' AND next_attempt_at<=now()
      AND (locked_until IS NULL OR locked_until<now()) ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING *`,
    [limit],
  );
  const results = { sent: 0, retrying: 0, failed: 0, suppressed: 0 };
  for (const n of claimed.rows) {
    const muted =
      n.recipient_user_id &&
      (optionalKinds as readonly string[]).includes(n.kind) &&
      (
        await pool.query(
          "SELECT 1 FROM notification_preferences WHERE user_id=$1 AND kind=$2 AND email=false",
          [n.recipient_user_id, n.kind],
        )
      ).rowCount;
    if (muted || !transport) {
      await pool.query(
        "UPDATE notifications SET status='suppressed',body_ciphertext=NULL,locked_until=NULL,last_error=$2 WHERE id=$1",
        [
          n.id,
          muted
            ? "Recipient turned off this notification"
            : "No email transport is configured",
        ],
      );
      results.suppressed++;
      continue;
    }
    try {
      const providerId = await transport.send({
        id: n.id,
        to: n.recipient_email,
        subject: n.subject,
        text: decrypt(n.body_ciphertext),
        replyTo: n.reply_to ?? undefined,
      });
      await pool.query(
        "UPDATE notifications SET status='sent',sent_at=now(),attempts=attempts+1,body_ciphertext=NULL,locked_until=NULL,provider=$2,provider_message_id=$3,last_error=NULL WHERE id=$1",
        [n.id, transport.name, providerId],
      );
      results.sent++;
    } catch (e) {
      const attempts = n.attempts + 1;
      const permanent =
        e instanceof PermanentDeliveryError || attempts >= maxAttempts;
      const error = (e instanceof Error ? e.message : "Delivery failed").slice(
        0,
        300,
      );
      await pool.query(
        `UPDATE notifications SET attempts=$2,locked_until=NULL,last_error=$3,provider=$4,
          status=CASE WHEN $5 THEN 'failed' ELSE 'pending' END,
          next_attempt_at=now()+($6*interval '1 minute') WHERE id=$1`,
        [
          n.id,
          attempts,
          error,
          transport.name,
          permanent,
          backoffMinutes[attempts - 1] ?? 0,
        ],
      );
      console.error("notification.delivery_failed", {
        id: n.id,
        attempts,
        permanent,
      });
      if (permanent) results.failed++;
      else results.retrying++;
    }
  }
  return results;
}

// ---------- Reminders ----------

/** How far ahead drivers are reminded; the job is safe to run more often. */
const reminderLeadHours = () => {
  const hours = Number(process.env.RELAY_APPOINTMENT_REMINDER_HOURS);
  return Number.isInteger(hours) && hours >= 3 && hours <= 72 ? hours : 24;
};
const day = () => new Date().toISOString().slice(0, 10);

/** Idempotent per day (or week for insurance) through dedupe keys. This is
 *  the daily sweep: missing proof of delivery, expiring insurance, overdue
 *  exceptions and retention of failed message bodies. */
export async function scheduleDailyReminders() {
  return transaction(async (c) => {
    const today = day();
    let queued = 0;
    const pods = await c.query(
      `SELECT l.id,l.reference,c.organization_id,m.user_id FROM loads l
      JOIN carriers c ON c.id=l.carrier_id
      JOIN memberships m ON m.carrier_id=l.carrier_id AND m.role IN ('dispatcher','carrier-manager')
      WHERE l.stage='delivered'
        AND (SELECT max(e.created_at) FROM load_events e WHERE e.load_id=l.id AND e.type='load.milestones') < now()-interval '24 hours'
        AND NOT EXISTS(SELECT 1 FROM documents d JOIN document_versions v ON v.document_id=d.id
          JOIN document_reviews r ON r.version_id=v.id AND r.decision='accepted'
          WHERE d.load_id=l.id AND d.type='pod')`,
    );
    for (const r of pods.rows) {
      await enqueueForUser(c, r.user_id, {
        kind: "document_reminder",
        organization: r.organization_id,
        dedupe: `document_reminder:${r.id}:${r.user_id}:${today}`,
        subject: `Proof of delivery still needed for load ${r.reference}`,
        text: `Load ${r.reference} was delivered more than 24 hours ago and does not have an accepted proof of delivery.\n\nUpload or review the POD in Relay.`,
      });
      queued++;
    }
    const insurance = await c.query(
      `SELECT c.id,c.name,c.organization_id,d.type,to_char(v.expires_on,'YYYY-MM-DD') expires_on,m.user_id,
        to_char(date_trunc('week',now()),'IYYY-IW') week
      FROM documents d JOIN carriers c ON c.id=d.carrier_id
      JOIN LATERAL (SELECT * FROM document_versions WHERE document_id=d.id ORDER BY version DESC LIMIT 1) v ON true
      JOIN memberships m ON m.carrier_id=c.id AND m.role IN ('dispatcher','carrier-manager')
      WHERE d.load_id IS NULL AND d.type IN ('insurance_auto_liability','insurance_cargo')
        AND v.expires_on <= (now() AT TIME ZONE 'UTC')::date+30`,
    );
    for (const r of insurance.rows) {
      const label = r.type === "insurance_cargo" ? "Cargo" : "Auto liability";
      await enqueueForUser(c, r.user_id, {
        kind: "insurance_reminder",
        organization: r.organization_id,
        dedupe: `insurance_reminder:${r.id}:${r.type}:${r.user_id}:${r.week}`,
        subject: `${label} insurance for ${r.name} expires ${r.expires_on}`,
        text: `${label} insurance on file for ${r.name} expires on ${r.expires_on}.\n\nUpload the renewed certificate in Relay (Carriers → Documents).`,
      });
      queued++;
    }
    const overdue = await c.query(
      `SELECT e.id,e.summary,e.owner_id,l.reference,c.organization_id FROM load_exceptions e
      JOIN loads l ON l.id=e.load_id JOIN carriers c ON c.id=e.carrier_id
      JOIN memberships m ON m.carrier_id=e.carrier_id AND m.user_id=e.owner_id
      WHERE e.status<>'resolved' AND e.due_at<now()`,
    );
    for (const r of overdue.rows) {
      await enqueueForUser(c, r.owner_id, {
        kind: "exception_overdue",
        organization: r.organization_id,
        dedupe: `exception_overdue:${r.id}:${r.owner_id}:${today}`,
        subject: `Overdue exception on load ${r.reference}`,
        text: `An exception you own on load ${r.reference} is past due: ${r.summary}\n\nOpen Relay to update or resolve it.`,
      });
      queued++;
    }
    // Retention: failed messages keep their sealed body for 7 days for retry.
    await c.query(
      "UPDATE notifications SET body_ciphertext=NULL WHERE status='failed' AND body_ciphertext IS NOT NULL AND created_at<now()-interval '7 days'",
    );
    return { candidates: queued };
  });
}

/** Appointment reminders: the assigned driver hears about each upcoming stop
 *  once a day ahead and once within two hours. Keys include the window start,
 *  so a rescheduled stop is announced again. Safe to run every few minutes;
 *  the two-hour tier is why it should be. */
export async function scheduleAppointmentReminders() {
  return transaction(async (c) => {
    let queued = 0;
    const upcoming = await c.query(
      `SELECT s.id,s.sequence,s.kind,s.address,s.timezone,s.window_start,s.window_end,
        l.reference,car.organization_id,m.user_id,
        (SELECT count(*)::int FROM load_stops x WHERE x.load_id=l.id) stop_count,
        (s.window_start<=now()+interval '2 hours') soon
      FROM load_stops s JOIN loads l ON l.id=s.load_id
      JOIN carriers car ON car.id=l.carrier_id
      JOIN load_assignments a ON a.load_id=l.id
      JOIN memberships m ON m.driver_id=a.driver_id AND m.carrier_id=a.carrier_id
      WHERE l.cancelled_at IS NULL AND l.stage<>'delivered'
        AND s.window_end>now()
        AND s.window_start<=now()+make_interval(hours=>$1)
        AND NOT EXISTS(SELECT 1 FROM stop_events e WHERE e.stop_id=s.id AND e.kind='arrived')`,
      [reminderLeadHours()],
    );
    for (const r of upcoming.rows) {
      const when = (v: Date) =>
        v.toLocaleString("en-US", {
          timeZone: r.timezone,
          dateStyle: "medium",
          timeStyle: "short",
        });
      const tier = r.soon ? "2h" : "lead";
      await enqueueForUser(c, r.user_id, {
        kind: "appointment_reminder",
        organization: r.organization_id,
        dedupe: `appointment_reminder:${r.id}:${new Date(r.window_start).getTime()}:${tier}:${r.user_id}`,
        subject: `${r.kind === "pickup" ? "Pickup" : "Delivery"} ${r.soon ? "soon" : "coming up"}: load ${r.reference}`,
        text: `${r.kind === "pickup" ? "Pickup" : "Delivery"} for load ${r.reference}${r.stop_count > 2 ? ` (stop ${r.sequence} of ${r.stop_count})` : ""}\n\n${r.address}\nAppointment: ${when(r.window_start)} – ${when(r.window_end)} (${r.timezone})\n\nTap to record your arrival in Relay when you get there. If you're running late, just let dispatch know. Safe travels!`,
      });
      queued++;
    }
    return { candidates: queued };
  });
}

/** Both sweeps, as the scheduled job ran before they were split. */
export async function scheduleReminders() {
  const daily = await scheduleDailyReminders();
  const appointments = await scheduleAppointmentReminders();
  return { candidates: daily.candidates + appointments.candidates };
}

// ---------- Log, retry and preferences ----------

export async function notificationLog(user: string) {
  const { rows } = await pool.query(
    `SELECT n.id,n.kind,n.recipient_email,n.subject,${receiptStatus("notification", "n")} status,n.attempts,n.last_error,n.provider,
      n.created_at,n.sent_at,n.next_attempt_at,(n.status='failed' AND n.body_ciphertext IS NOT NULL) retryable
    FROM notifications n
    WHERE n.organization_id IN (SELECT c.organization_id FROM carriers c JOIN memberships m ON m.carrier_id=c.id
      WHERE m.user_id=$1 AND m.role='dispatcher')
    ORDER BY n.created_at DESC,n.id LIMIT 100`,
    [user],
  );
  return {
    transport: configuredTransport()?.name ?? "none",
    notifications: rows,
  };
}
export async function retryNotification(user: string, id: string) {
  const { rows } = await pool.query(
    `UPDATE notifications n SET status='pending',attempts=0,next_attempt_at=now(),last_error=NULL
    WHERE n.id=$1 AND n.status='failed' AND n.body_ciphertext IS NOT NULL
      AND n.organization_id IN (SELECT c.organization_id FROM carriers c JOIN memberships m ON m.carrier_id=c.id
        WHERE m.user_id=$2 AND m.role='dispatcher')
    RETURNING id`,
    [id, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  await pool.query(
    "INSERT INTO audit_logs VALUES($1,$2,'notification.retried',$3,now())",
    [randomUUID(), user, id],
  );
  return { id };
}
export async function preferences(user: string) {
  const { rows } = await pool.query(
    "SELECT kind,email FROM notification_preferences WHERE user_id=$1",
    [user],
  );
  return Object.fromEntries(
    optionalKinds.map((k) => [
      k,
      rows.find((r) => r.kind === k)?.email ?? true,
    ]),
  ) as Record<OptionalKind, boolean>;
}
export async function savePreference(user: string, input: unknown) {
  const data = z
    .object({ kind: z.enum(optionalKinds), email: z.boolean() })
    .strict()
    .parse(input);
  await pool.query(
    `INSERT INTO notification_preferences(user_id,kind,email) VALUES($1,$2,$3)
    ON CONFLICT(user_id,kind) DO UPDATE SET email=$3,updated_at=now()`,
    [user, data.kind, data.email],
  );
  return preferences(user);
}
