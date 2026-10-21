# 0025 — Inbound attachments and abandoned-upload cleanup

Status: accepted, 2026-10-21. Extends ADR 0018 (attachments) and ADR 0023 (inbound).

## Inbound attachments

Replies can bring files. They go through exactly the pipeline of outgoing attachments: type sniffed from the bytes (PDF, PNG, JPEG only), 4 MB limit, virus scan (fail-closed when `RELAY_REQUIRE_MALWARE_SCAN` is set), write-once object storage, and the same download rule (anyone who can see the conversation, audited, 60-second signed URL on S3).

- **Email:** the signed webhook accepts `attachments: [{filename, content_base64}]` (up to 6 listed, 3 kept, 32 MiB request cap).
- **Text (MMS):** Twilio's `NumMedia`/`MediaUrl{n}`. Relay fetches a media URL **only** if its origin is the configured Twilio API host (`TWILIO_API_BASE`, default `api.twilio.com`) and credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`) exist. The one redirect Twilio issues to its CDN is followed without credentials. Any other URL is refused and never fetched, so a signed-but-hostile payload cannot make the server request internal addresses.
- **Never fatal:** a file that is unsupported, too large, infected or unfetchable is dropped, and the stored message ends with a line such as "2 attachments not saved: unsupported type; blocked by the virus scan", so the loss is visible. A message with only files is stored as "(attachment only)".
- **Idempotent:** storage keys derive from the provider message id, and the duplicate check runs before any fetch, so a provider retry neither refetches nor stores twice. Inbound files have no Relay uploader (migration 022 makes `uploader_id` nullable, but only for rows attached to a message).

## Abandoned-upload cleanup

`cleanupAbandoned()` runs with the existing daily job (`/api/jobs/notifications`, and safe to run more often):

1. **Unattached message files** older than 24 hours: the object is deleted, then the record and byte row, with an audit entry. The delete is re-checked inside the transaction, so a file attached meanwhile survives. If object storage is down the record is kept and the next run retries; nothing is orphaned by a half-finished cleanup.
2. **Expired direct-upload reservations** (ADR 0015) still `pending` an hour after expiry: the quarantine object is deleted and the session closed as `UPLOAD_EXPIRED`.

This relaxes "Relay never deletes" in exactly one place. A database trigger allows deleting only `message_attachments` rows with no message and their `message-attachments/…` byte rows; attached files, document versions and every other object stay append-only. Relay's S3 credentials now need `s3:DeleteObject` (limit it to the `message-attachments/` and `quarantine/` prefixes if your provider supports prefix policies). A bucket lifecycle rule on `quarantine/` remains a good second line of defence.

## Not included

Inline images in HTML mail, attachments over 4 MB, video/audio/vCard MMS parts, forwarding a stored file to a new message, and per-tenant retention periods for attached files.

## Rollback

Migration 022 only widens two triggers and drops one NOT NULL. Stop calling `cleanupAbandoned()` to disable cleanup; rejected inbound files are never retried.
