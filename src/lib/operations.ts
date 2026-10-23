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
    jobs: await jobStatus(),
    observed_at: new Date().toISOString(),
  };
}
