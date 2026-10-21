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
