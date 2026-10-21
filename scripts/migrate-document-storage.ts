import { pool } from "../src/lib/db";
import { objectStore } from "../src/lib/storage";
import { migratePostgresObjects } from "../src/lib/document-storage-migration";

// Copies documents stored in PostgreSQL into the configured bucket
// (RELAY_DOCUMENT_STORE=s3 and S3_* variables). Rerun until it reports done.
const store = objectStore();
if (!store)
  throw new Error("Set RELAY_DOCUMENT_STORE=s3 and the S3_* variables first");
try {
  let total = 0;
  for (;;) {
    const batch = await migratePostgresObjects(store, 100);
    total += batch.moved;
    console.log(`Moved ${total} document objects so far`);
    if (!batch.remaining) break;
  }
  console.log("Document storage migration complete");
} finally {
  await pool.end();
}
