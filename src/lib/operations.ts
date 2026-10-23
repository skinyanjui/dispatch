import { configWarnings } from "./config-check";
import { pool } from "./db";
import { HttpError } from "./auth";
import { canSeeJobStatus, jobStatus } from "./jobs";
import { messageCapabilities } from "./messaging";

/** Configuration presence and release evidence only; never return secret values. */
export async function operationsStatus(user: string) {
  if (!(await canSeeJobStatus(user))) throw new HttpError(404, "NOT_FOUND");
  const schema = await pool.query(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return {
    release: {
      revision: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      environment: process.env.VERCEL_ENV ?? "local",
      deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      schema: schema.rows.map((r) => r.version as string),
    },
    capabilities: {
      messaging: messageCapabilities(),
      delivery_callbacks: {
        sms: !!process.env.TWILIO_AUTH_TOKEN,
        email: !!process.env.RESEND_WEBHOOK_SECRET,
      },
      storage: process.env.RELAY_DOCUMENT_STORE === "s3" ? "s3" : "postgres",
      scanner: process.env.RELAY_MALWARE_SCANNER === "clamav",
      scanner_required: process.env.RELAY_REQUIRE_MALWARE_SCAN === "true",
      ai_provider_configured: !!process.env.ANTHROPIC_API_KEY,
      cron_configured:
        !!process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16,
    },
    config_warnings:
      process.env.NODE_ENV === "production" ? configWarnings() : [],
    jobs: await jobStatus(),
    // Exports waiting more than two minutes mean the worker is not keeping up;
    // stalled ones were failed after 30 minutes without starting.
    exports: (
      await pool.query(
        `SELECT count(*) FILTER (WHERE status='queued' AND created_at<now()-interval '2 minutes')::int waiting,
                count(*) FILTER (WHERE error_code='EXPORT_STALLED' AND finished_at>now()-interval '24 hours')::int stalled_last_24h
         FROM report_exports`,
      )
    ).rows[0] as { waiting: number; stalled_last_24h: number },
    observed_at: new Date().toISOString(),
  };
}
