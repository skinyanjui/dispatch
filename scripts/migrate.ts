import { readFile } from "node:fs/promises";
import { pool, transaction } from "../src/lib/db";
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
