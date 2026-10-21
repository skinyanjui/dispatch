# 0015 — Direct-to-bucket uploads for files over 4 MB

Status: accepted, 2026-10-21. Extends ADR 0012.

## Decision

Files up to 4 MiB still upload through the app server (scan → store → record). Files from 4 MiB up to **25 MiB** go straight from the browser to the bucket, then Relay verifies and scans them before they exist as documents. This needs `RELAY_DOCUMENT_STORE=s3`; without a bucket the server answers `409 DIRECT_UPLOAD_UNAVAILABLE`.

1. **Session.** `POST /api/documents/uploads` takes the usual document fields plus `filename`, `size_bytes` and `sha256` (computed in the browser). The server authorizes the caller exactly as for a normal upload, and returns early if the same request already finished. Otherwise it records a `document_upload_sessions` row with a quarantine key `quarantine/{carrier}/{session}` and returns a **15-minute presigned PUT**. `Content-Length` and `Content-Type` are signed headers, so the provider rejects any body of a different size. Retrying with the same idempotency key returns the same session; changed content under that key is `409 IDEMPOTENCY_CONFLICT`.
2. **Upload.** The browser PUTs the file to the returned URL. The app server never sees the bytes.
3. **Finalize.** `POST /api/documents/uploads/:id/finalize`, only by the session's own user, re-checks permissions. It then reads the object back from quarantine and verifies, in order: size, SHA-256 against the declared value, and content type from magic bytes (the filename is ignored). It runs the malware scan with the same rules as ADR 0012 (infected → logged, never recorded; scanner unreachable or required-but-missing → fail closed). Only then does it server-side **copy** the object to its final write-once key and record the version, scan row and events in one transaction.
4. **Outcomes.**
   - Permanent failures (size or checksum mismatch, unsupported type, malware) mark the session `rejected` with a reason that is returned again on every retry.
   - Transient failures (scanner or storage outage, object not yet received) leave it `pending` so the same upload can be retried.
   - A session not finalized within one hour of creation returns `410 UPLOAD_EXPIRED`. Finalize is idempotent: repeating it returns the same version.

Versions, review, scan history, immutability and downloads (a 60-second signed redirect) are shared with the proxied path (`recordVersion`). Direct uploads cannot skip a check the proxied path has. The client picks the path from the file size (`src/lib/upload-client.ts`).

## Operating notes

- **Bucket CORS** must allow the app origin to `PUT` with the `Content-Type` and `Content-Length` request headers, for example `AllowedOrigins: ["https://your-app.example"]`, `AllowedMethods: ["PUT"]`, `AllowedHeaders: ["content-type"]`. Cloudflare R2 and MinIO need the same.
- Quarantine objects are never served. Add a lifecycle rule that **expires `quarantine/` after 1 day**; Relay itself does not delete from the bucket. Rejected or abandoned uploads therefore age out, and the permanent copy under `documents/` is never touched by that rule.
- The scan reads the whole file into the server process (25 MiB maximum), so serverless memory and the `clamd` `StreamMaxLength` (`INSTREAM` size limit) must be at least 25 MiB. A smaller limit produces `SCAN_UNAVAILABLE` rather than an unscanned file.
- Large files are hashed in browser memory, so very constrained phones may struggle near the limit. The 25 MiB ceiling is a cap on that and on scan memory, not a bucket limit.

## Testing and limits

Integration tests use an in-process S3 stand-in that **recomputes the presigned signature** from the request as received, as S3 does, so a body of a different size is rejected (this also validates the signer end to end), plus a fake `clamd`. They cover the happy path, retries, checksum and type checks, infection, outages, expiry, access lost mid-upload and foreign finalize. A Chromium test stubs the bucket and verifies the client flow: it hashes, never posts the large body to the app server, and retries after a failed PUT with the same key. No live bucket was available here, so run one real large upload against your provider (including its CORS rules) before relying on this.

Not included: resumable or multipart uploads (a failed upload restarts), uploads above 25 MiB, and background cleanup of expired sessions (the `pending` rows are small and expire logically).

## Rollback

Keep migration 013 (the version size limit is widened to 25 MiB and the new table is additive). Older code ignores sessions, but files uploaded directly are only readable while `RELAY_DOCUMENT_STORE=s3` is configured.
