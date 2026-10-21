import type { PoolClient } from "pg";

// Document bytes are written through this interface. The default store keeps
// immutable objects in PostgreSQL inside the same transaction as the version
// record, so an upload is never half-recorded. See ADR 0007 for the object
// storage migration path (presigned upload, finalize, signed download).
export interface DocumentStore {
  put(c: PoolClient, key: string, content: Buffer): Promise<void>;
  get(c: PoolClient, key: string): Promise<Buffer | null>;
}
export const postgresStore: DocumentStore = {
  async put(c, key, content) {
    await c.query(
      "INSERT INTO document_objects(storage_key,content) VALUES($1,$2)",
      [key, content],
    );
  },
  async get(c, key) {
    const { rows } = await c.query(
      "SELECT content FROM document_objects WHERE storage_key=$1",
      [key],
    );
    return rows[0]?.content ?? null;
  },
};
