import { createHash } from "node:crypto";
import { pool } from "./db";
import { configWarnings } from "./config-check";
import type { JobStatus } from "./jobs";
import { authorityAttention } from "./authority";

/**
 * Pushes operational problems to a chat or paging webhook so they are not only
 * visible to someone who opens the operations page. The webhook receives a
 * Slack-compatible `{ "text": ... }` body that names counts and checks, never
 * customer data. A problem is announced when it first appears, again when its
 * detail changes, and then once a day while it lasts. A failed delivery is not
 * recorded, so the next 15-minute tick retries it.
 */
export type Alert = { key: string; text: string };
const resendAfterHours = 24;

export async function collectAlerts(jobs: JobStatus[]): Promise<Alert[]> {
  const alerts: Alert[] = [];
  for (const j of jobs)
    if (j.state === "failing" || j.state === "stale")
      alerts.push({
        key: "job:" + j.scope,
        text: `The ${j.scope} scheduled job is ${j.state} (last success ${j.last_success_at ?? "never"}).`,
      });
  const { rows } = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM notifications WHERE status='failed' AND created_at>now()-interval '24 hours') failed_notifications,
      (SELECT count(*)::int FROM report_exports WHERE error_code='EXPORT_STALLED' AND finished_at>now()-interval '24 hours') stalled_exports,
      (SELECT count(*)::int FROM notifications WHERE status='pending' AND next_attempt_at<now()-interval '1 hour') overdue_notifications`,
  );
  const r = rows[0];
  if (r.failed_notifications)
    alerts.push({
      key: "notifications.failed",
      text: `${r.failed_notifications} notification(s) failed permanently in the last 24 hours.`,
    });
  if (r.overdue_notifications)
    alerts.push({
      key: "notifications.overdue",
      text: `${r.overdue_notifications} queued notification(s) are more than an hour overdue.`,
    });
  if (r.stalled_exports)
    alerts.push({
      key: "exports.stalled",
      text: `${r.stalled_exports} report export(s) never started in the last 24 hours.`,
    });
  const authority = await authorityAttention();
  if (authority)
    alerts.push({
      key: "authority.attention",
      text: `${authority} carrier(s) have a registration finding that needs a person (authority, insurance, out of service or a USDOT mismatch).`,
    });
  if (process.env.NODE_ENV === "production") {
    const warnings = configWarnings();
    if (warnings.length)
      alerts.push({
        key: "config",
        text: "Security configuration: " + warnings.join(" "),
      });
  }
  return alerts;
}

export async function sendAlerts(
  jobs: JobStatus[],
  post: (url: string, body: string) => Promise<Response> = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    }),
) {
  const url = process.env.RELAY_ALERT_WEBHOOK_URL?.trim();
  if (!url) return { configured: false as const };
  if (!url.startsWith("https://"))
    throw new Error("RELAY_ALERT_WEBHOOK_URL must be https");
  const alerts = await collectAlerts(jobs);
  const active = new Set(alerts.map((a) => a.key));
  // Resolved conditions are forgotten so a recurrence is announced again.
  await pool.query("DELETE FROM alert_state WHERE NOT (key = ANY($1))", [
    [...active],
  ]);
  let sent = 0;
  for (const alert of alerts) {
    const fingerprint = createHash("sha256").update(alert.text).digest("hex");
    const { rows } = await pool.query(
      `SELECT 1 FROM alert_state WHERE key=$1 AND fingerprint=$2
        AND last_sent_at>now()-make_interval(hours=>$3)`,
      [alert.key, fingerprint, resendAfterHours],
    );
    if (rows[0]) continue;
    const response = await post(
      url,
      JSON.stringify({ text: "Relay alert: " + alert.text }),
    );
    if (!response.ok)
      throw new Error("Alert webhook answered " + response.status);
    await pool.query(
      `INSERT INTO alert_state(key,fingerprint) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET fingerprint=$2,last_sent_at=now()`,
      [alert.key, fingerprint],
    );
    console.warn("alert.sent", { key: alert.key });
    sent++;
  }
  return { configured: true as const, active: alerts.length, sent };
}
