import { readFile } from "node:fs/promises";
import { pool, transaction } from "../src/lib/db";
try {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(813371)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY)",
    );
    const exists = await c.query(
      "SELECT 1 FROM schema_migrations WHERE version='001'",
    );
    if (!exists.rowCount) {
      await c.query(
        await readFile(
          new URL("../db/001_foundation.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations VALUES('001')");
    }
  });
  console.log("Migrations current");
} finally {
  await pool.end();
}
