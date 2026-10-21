import { pool, transaction } from "./db";
import { sha256Hex } from "./sigv4";
import type { S3Client } from "./storage";

/**
 * Moves PostgreSQL-held document bytes into the bucket, one row at a time:
 * write-once PUT, read back and compare the checksum, then (in a transaction
 * that re-locks the row) clear the bytes and record the bucket. Safe to stop
 * and rerun; rows already moved are skipped.
 */
export async function migratePostgresObjects(store: S3Client, limit = 100) {
  const { rows } = await pool.query(
    `SELECT o.storage_key,v.sha256 FROM document_objects o
    JOIN document_versions v ON v.storage_key=o.storage_key
    WHERE o.backend='postgres' ORDER BY o.created_at LIMIT $1`,
    [limit],
  );
  let moved = 0;
  for (const row of rows) {
    // Bytes are immutable, so they can be copied outside a transaction; the
    // final update re-checks the row so concurrent runs cannot double-move.
    const read = await pool.query(
      "SELECT content FROM document_objects WHERE storage_key=$1 AND backend='postgres'",
      [row.storage_key],
    );
    if (!read.rows[0]) continue;
    const content: Buffer = read.rows[0].content;
    if (sha256Hex(content) !== row.sha256)
      throw new Error(
        "Stored bytes do not match their recorded checksum: " + row.storage_key,
      );
    await store.put(row.storage_key, content, row.sha256);
    if (sha256Hex(await store.get(row.storage_key)) !== row.sha256)
      throw new Error("Bucket copy failed verification: " + row.storage_key);
    await transaction(async (c) => {
      const updated = await c.query(
        "UPDATE document_objects SET backend='s3',bucket=$2,content=NULL,migrated_at=now() WHERE storage_key=$1 AND backend='postgres'",
        [row.storage_key, store.bucket],
      );
      moved += updated.rowCount ?? 0;
    });
  }
  return { moved, remaining: rows.length === limit };
}
