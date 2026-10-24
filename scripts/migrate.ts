import { readFile } from "node:fs/promises";
// Migrations may use a separate owner role (docs/runbooks/database-roles.md),
// so the runtime role needs no rights to change tables or disable triggers.
if (process.env.MIGRATION_DATABASE_URL)
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
const { pool, transaction } = await import("../src/lib/db");
try {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(813371)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY)",
    );
    for (const [version, filename] of [
      ["001", "001_foundation.sql"],
      ["002", "002_auth_controls.sql"],
      ["003", "003_manual_check_ins.sql"],
      ["004", "004_onboarding.sql"],
      ["005", "005_documents.sql"],
      ["006", "006_exceptions.sql"],
      ["007", "007_billing.sql"],
      ["008", "008_notifications.sql"],
      ["009", "009_account_admin.sql"],
      ["010", "010_document_storage_scanning.sql"],
      ["011", "011_check_in_amendments.sql"],
      ["012", "012_stop_events.sql"],
      ["013", "013_direct_uploads.sql"],
      ["014", "014_staff_invites.sql"],
      ["015", "015_contacts.sql"],
      ["016", "016_messaging.sql"],
      ["017", "017_load_changes.sql"],
      ["018", "018_appointment_reminders.sql"],
      ["019", "019_sms_resend.sql"],
      ["020", "020_message_attachments.sql"],
      ["021", "021_inbound_messages.sql"],
      ["022", "022_attachment_cleanup.sql"],
      ["023", "023_load_change_requests.sql"],
      ["024", "024_ai_document_reading.sql"],
      ["025", "025_prospects.sql"],
      ["026", "026_assistant.sql"],
      ["027", "027_rate_confirmation_reads.sql"],
      ["028", "028_session_remember.sql"],
      ["029", "029_access_requests.sql"],
      ["030", "030_external_identities.sql"],
      ["031", "031_thread_states.sql"],
      ["032", "032_load_notes.sql"],
      ["033", "033_saved_views.sql"],
      ["034", "034_document_drafts.sql"],
      ["035", "035_job_runs.sql"],
      ["036", "036_audit_organization.sql"],
      ["037", "037_fleet_vehicles.sql"],
      ["038", "038_report_exports.sql"],
      ["039", "039_provider_receipts.sql"],
      ["040", "040_alert_state.sql"],
      ["041", "041_indexes_and_sessions.sql"],
      ["042", "042_change_control.sql"],
    ]) {
      const exists = await c.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [version],
      );
      if (!exists.rowCount) {
        await c.query(
          await readFile(new URL("../db/" + filename, import.meta.url), "utf8"),
        );
        await c.query("INSERT INTO schema_migrations VALUES($1)", [version]);
      }
    }
  });
  console.log("Migrations current");
} finally {
  await pool.end();
}
