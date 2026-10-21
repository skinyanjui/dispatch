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

export type StoredFile = {
  filename: string;
  contentType: string;
  sha256: string;
  size: number;
  scan: "clean" | "not_scanned";
  storageKey: string;
  object:
    | { backend: "s3"; bucket: string }
    | { backend: "postgres"; bytes: Buffer };
};

/**
 * Validates, scans and writes the bytes. Infected files are never stored; a
 * missing scanner fails closed only when scanning is required (ADR 0012).
 */
export async function scanAndStore(
  actor: string | null,
  bytes: Buffer,
  rawName: string,
  storageKey: string,
): Promise<StoredFile> {
  if (bytes.length === 0) throw new HttpError(400, "FILE_REQUIRED");
  if (bytes.length > maxDocumentBytes)
    throw new HttpError(413, "FILE_TOO_LARGE");
  const contentType = sniffContentType(bytes);
  if (!contentType) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let scan: "clean" | "not_scanned" = "not_scanned";
  const scanner = configuredScanner();
  if (!scanner && scanRequired()) throw new HttpError(503, "SCAN_UNAVAILABLE");
  if (scanner) {
    try {
      const result = await scanner.scan(bytes);
      if (result.verdict === "infected") {
        await pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
          randomUUID(),
          actor,
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
  const bucket = objectStore();
  if (bucket)
    try {
      await bucket.put(storageKey, bytes, sha256);
    } catch (e) {
      if (!(e instanceof StorageUnavailable)) throw e;
      console.error("message_attachment.storage_unavailable", e.message);
      throw new HttpError(503, "STORAGE_UNAVAILABLE");
    }
  return {
    filename: cleanFilename(rawName),
    contentType,
    sha256,
    size: bytes.length,
    scan,
    storageKey,
    object: bucket
      ? { backend: "s3", bucket: bucket.bucket }
      : { backend: "postgres", bytes },
  };
}

async function recordFile(
  c: PoolClient,
  id: string,
  uploader: string | null,
  messageId: string | null,
  f: StoredFile,
) {
  await c.query(
    "INSERT INTO document_objects(storage_key,content,backend,bucket) VALUES($1,$2,$3,$4)",
    f.object.backend === "s3"
      ? [f.storageKey, null, "s3", f.object.bucket]
      : [f.storageKey, f.object.bytes, "postgres", null],
  );
  await c.query(
    `INSERT INTO message_attachments(id,uploader_id,message_id,linked_at,filename,content_type,size_bytes,sha256,storage_key,scan)
    VALUES($1,$2,$3,CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      uploader,
      messageId,
      f.filename,
      f.contentType,
      f.size,
      f.sha256,
      f.storageKey,
      f.scan,
    ],
  );
}

/** Files that arrived with an email or text, attached as the message is stored. */
export async function recordInbound(
  c: PoolClient,
  messageId: string,
  files: StoredFile[],
) {
  for (const f of files) await recordFile(c, randomUUID(), null, messageId, f);
}

/** Stores and scans a file for later attachment to a message. */
export async function uploadAttachment(
  user: string,
  file: { name: string; bytes: Buffer } | null,
) {
  if (!file || file.bytes.length === 0)
    throw new HttpError(400, "FILE_REQUIRED");
  const pending = await pool.query(
    "SELECT count(*)::int n FROM message_attachments WHERE uploader_id=$1 AND message_id IS NULL AND created_at>now()-interval '1 day'",
    [user],
  );
  if (pending.rows[0].n >= maxPendingPerDay)
    throw new HttpError(429, "TOO_MANY_ATTACHMENTS");
  const id = randomUUID();
  const stored = await scanAndStore(
    user,
    file.bytes,
    file.name,
    `message-attachments/${user}/${id}`,
  );
  await transaction(async (c) => {
    await recordFile(c, id, user, null, stored);
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "message_attachment.uploaded",
      id,
    ]);
  });
  return {
    id,
    filename: stored.filename,
    content_type: stored.contentType,
    size_bytes: stored.size,
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

// ---------- Abandoned uploads (ADR 0025) ----------

const attachmentGraceHours = 24;
const sessionGraceHours = 1;

/**
 * Removes files nobody attached and direct-upload reservations nobody
 * finished. Attached files and document versions are never touched: only
 * `message_attachments` rows with no message, and `pending` upload sessions
 * past their expiry. Each item is independent, so one failure leaves the rest
 * to the next run; the object is deleted before its record so a failed delete
 * is retried rather than orphaned.
 */
export async function cleanupAbandoned(limit = 200) {
  const out = { attachments: 0, upload_sessions: 0, failed: 0 };
  const bucket = objectStore();
  const stale = await pool.query(
    `SELECT a.id,a.storage_key,o.backend FROM message_attachments a
    JOIN document_objects o ON o.storage_key=a.storage_key
    WHERE a.message_id IS NULL AND a.created_at<now()-make_interval(hours=>$1)
    ORDER BY a.created_at LIMIT $2`,
    [attachmentGraceHours, limit],
  );
  for (const row of stale.rows) {
    try {
      if (row.backend === "s3") {
        if (!bucket) throw new StorageUnavailable("No object store configured");
        await bucket.delete(row.storage_key);
      }
      await transaction(async (c) => {
        // Re-check inside the transaction: it may have been attached meanwhile.
        const gone = await c.query(
          "DELETE FROM message_attachments WHERE id=$1 AND message_id IS NULL RETURNING id",
          [row.id],
        );
        if (!gone.rowCount) return;
        await c.query("DELETE FROM document_objects WHERE storage_key=$1", [
          row.storage_key,
        ]);
        await c.query("INSERT INTO audit_logs VALUES($1,NULL,$2,$3,now())", [
          randomUUID(),
          "message_attachment.abandoned_removed",
          row.id,
        ]);
        out.attachments++;
      });
    } catch (e) {
      out.failed++;
      console.error(
        "cleanup.attachment_failed",
        row.id,
        e instanceof Error ? e.message : e,
      );
    }
  }
  const sessions = await pool.query(
    `SELECT id,quarantine_key,bucket FROM document_upload_sessions
    WHERE status='pending' AND expires_at<now()-make_interval(hours=>$1)
    ORDER BY expires_at LIMIT $2`,
    [sessionGraceHours, limit],
  );
  for (const row of sessions.rows) {
    try {
      if (!bucket || bucket.bucket !== row.bucket)
        throw new StorageUnavailable("Upload bucket is not configured");
      await bucket.delete(row.quarantine_key);
      const done = await pool.query(
        "UPDATE document_upload_sessions SET status='rejected',failure='UPLOAD_EXPIRED' WHERE id=$1 AND status='pending'",
        [row.id],
      );
      if (done.rowCount) {
        out.upload_sessions++;
        await pool.query("INSERT INTO audit_logs VALUES($1,NULL,$2,$3,now())", [
          randomUUID(),
          "document_upload.abandoned_removed",
          row.id,
        ]);
      }
    } catch (e) {
      out.failed++;
      console.error(
        "cleanup.upload_session_failed",
        row.id,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return out;
}
