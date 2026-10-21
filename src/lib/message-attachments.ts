import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { HttpError } from "./auth";
import { objectStore, StorageUnavailable } from "./storage";
import { configuredScanner, scanRequired, ScannerUnavailable } from "./malware";
import {
  cleanFilename,
  maxDocumentBytes,
  sniffContentType,
} from "./compliance";

export const maxAttachmentsPerMessage = 3;
const maxPendingPerDay = 20;

/**
 * Stores and scans a file for later attachment to a message. Infected files
 * are never stored; a missing scanner fails closed only when scanning is
 * required, exactly as for documents (ADR 0012).
 */
export async function uploadAttachment(
  user: string,
  file: { name: string; bytes: Buffer } | null,
) {
  if (!file || file.bytes.length === 0)
    throw new HttpError(400, "FILE_REQUIRED");
  if (file.bytes.length > maxDocumentBytes)
    throw new HttpError(413, "FILE_TOO_LARGE");
  const contentType = sniffContentType(file.bytes);
  if (!contentType) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE");
  const pending = await pool.query(
    "SELECT count(*)::int n FROM message_attachments WHERE uploader_id=$1 AND message_id IS NULL AND created_at>now()-interval '1 day'",
    [user],
  );
  if (pending.rows[0].n >= maxPendingPerDay)
    throw new HttpError(429, "TOO_MANY_ATTACHMENTS");
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const filename = cleanFilename(file.name);
  let scan: "clean" | "not_scanned" = "not_scanned";
  const scanner = configuredScanner();
  if (!scanner && scanRequired()) throw new HttpError(503, "SCAN_UNAVAILABLE");
  if (scanner) {
    try {
      const result = await scanner.scan(file.bytes);
      if (result.verdict === "infected") {
        await pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
          randomUUID(),
          user,
          "message_attachment.malware_rejected",
          sha256,
        ]);
        throw new HttpError(422, "MALWARE_DETECTED");
      }
      scan = "clean";
    } catch (e) {
      if (e instanceof ScannerUnavailable)
        throw new HttpError(503, "SCAN_UNAVAILABLE");
      throw e;
    }
  }
  const id = randomUUID();
  const storageKey = `message-attachments/${user}/${id}`;
  const bucket = objectStore();
  if (bucket)
    try {
      await bucket.put(storageKey, file.bytes, sha256);
    } catch (e) {
      if (!(e instanceof StorageUnavailable)) throw e;
      console.error("message_attachment.storage_unavailable", e.message);
      throw new HttpError(503, "STORAGE_UNAVAILABLE");
    }
  await transaction(async (c) => {
    await c.query(
      "INSERT INTO document_objects(storage_key,content,backend,bucket) VALUES($1,$2,$3,$4)",
      bucket
        ? [storageKey, null, "s3", bucket.bucket]
        : [storageKey, file.bytes, "postgres", null],
    );
    await c.query(
      "INSERT INTO message_attachments(id,uploader_id,filename,content_type,size_bytes,sha256,storage_key,scan) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        user,
        filename,
        contentType,
        file.bytes.length,
        sha256,
        storageKey,
        scan,
      ],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "message_attachment.uploaded",
      id,
    ]);
  });
  return {
    id,
    filename,
    content_type: contentType,
    size_bytes: file.bytes.length,
  };
}

/** Links the caller's own unattached files to a message. Anything else is 404. */
export async function linkAttachments(
  c: PoolClient,
  user: string,
  ids: string[],
  messageId: string,
) {
  if (!ids.length) return;
  const { rowCount } = await c.query(
    `UPDATE message_attachments SET message_id=$3,linked_at=now()
    WHERE id=ANY($1::uuid[]) AND uploader_id=$2 AND message_id IS NULL`,
    [ids, user, messageId],
  );
  if (rowCount !== ids.length) throw new HttpError(404, "NOT_FOUND");
}

export type AttachmentDownload =
  | { kind: "inline"; filename: string; content_type: string; content: Buffer }
  | { kind: "redirect"; url: string };

/**
 * Whoever can see the message's conversation may download its files; before it
 * is attached only the uploader may. `visible` is the caller's thread
 * predicate from messaging.ts (parameter $1 = user).
 */
export async function attachmentContent(
  user: string,
  id: string,
  visible: string,
): Promise<AttachmentDownload> {
  const { rows } = await pool.query(
    `SELECT a.* FROM message_attachments a
    LEFT JOIN messages m ON m.id=a.message_id
    LEFT JOIN threads t ON t.id=m.thread_id
    WHERE a.id=$2 AND ((a.message_id IS NULL AND a.uploader_id=$1) OR (t.id IS NOT NULL AND ${visible}))`,
    [user, id],
  );
  const file = rows[0];
  if (!file) throw new HttpError(404, "NOT_FOUND");
  const object = (
    await pool.query(
      "SELECT backend,bucket,content FROM document_objects WHERE storage_key=$1",
      [file.storage_key],
    )
  ).rows[0];
  await pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    "message_attachment.downloaded",
    id,
  ]);
  if (object?.backend === "postgres" && object.content)
    return {
      kind: "inline",
      filename: file.filename,
      content_type: file.content_type,
      content: object.content,
    };
  const bucket = objectStore();
  if (!object || !bucket || bucket.bucket !== object.bucket)
    throw new HttpError(503, "DOCUMENT_UNAVAILABLE");
  return {
    kind: "redirect",
    url: bucket.presignDownload(
      file.storage_key,
      file.filename,
      file.content_type,
    ),
  };
}
