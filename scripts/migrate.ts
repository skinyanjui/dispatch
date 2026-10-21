import { readFile } from "node:fs/promises";
import { pool, transaction } from "../src/lib/db";
try {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(813371)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY)",
    );
    for (const version of ["001", "002"]) {
      const exists = await c.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [version],
      );
      if (!exists.rowCount) {
        const filename =
          version === "001" ? "001_foundation.sql" : "002_auth_controls.sql";
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
