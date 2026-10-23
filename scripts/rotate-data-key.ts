import { pool } from "../src/lib/db";
import { decrypt, encrypt, needsReseal } from "../src/lib/secrets";

// Re-seals every stored secret with the current RELAY_DATA_KEY. Run it with the
// new key in RELAY_DATA_KEY and the old one in RELAY_DATA_KEY_PREVIOUS
// (docs/runbooks/key-rotation.md). Safe to repeat: rows already under the
// current key are skipped. Pass --dry-run to count without writing.
const dry = process.argv.includes("--dry-run");
const targets = [
  { table: "users", id: "id", column: "mfa_secret_ciphertext" },
  { table: "notifications", id: "id", column: "body_ciphertext" },
];
try {
  for (const { table, id, column } of targets) {
    const { rows } = await pool.query(
      `SELECT ${id} AS id, ${column} AS sealed FROM ${table} WHERE ${column} IS NOT NULL`,
    );
    let resealed = 0;
    for (const row of rows) {
      if (!needsReseal(row.sealed)) continue;
      resealed++;
      if (dry) continue;
      const sealed = encrypt(decrypt(row.sealed));
      await pool.query(
        `UPDATE ${table} SET ${column}=$2 WHERE ${id}=$1 AND ${column}=$3`,
        [row.id, sealed, row.sealed],
      );
    }
    console.log(
      `${table}.${column}: ${rows.length} sealed, ${resealed} ${dry ? "would be " : ""}re-sealed`,
    );
  }
} finally {
  await pool.end();
}
