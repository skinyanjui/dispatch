# 0007 — Versioned documents and carrier compliance files

Status: accepted, 2026-10-21.

## Decision

A **document** is a slot: one per carrier for each compliance type (dispatch agreement, auto liability insurance, cargo insurance, W-9) and one per load for each paperwork type (rate confirmation, BOL, POD). Every upload is an immutable `document_versions` row. Review decisions are append-only `document_reviews` rows. Current status (missing, awaiting review, accepted, rejected, expiring within 30 days, expired) is **derived** from the latest version, its latest review and its expiry date by `documentStatus()` in `src/lib/compliance.ts`. That function is shared by the server, UI and demo. No mutable status column exists that could drift.

- **Storage.** Bytes are written through the `DocumentStore` interface (`src/lib/storage.ts`). The default store keeps immutable `document_objects` rows in PostgreSQL inside the same transaction as the version, so there are no orphaned uploads and no half-recorded versions. No paid object storage was provisioned. To move to object storage, keep the version table, add a presigned `PUT` to a quarantine prefix, then `finalize` (checksum + scan) to create the version. Downloads then use short-lived signed URLs after the same authorization check.
- **Limits.** 4 MiB per file (Vercel serverless request bodies are capped near 4.5 MB). The byte cap applies while streaming, before multipart parsing. The type is sniffed from magic bytes (PDF, PNG, JPEG). Client file type/extension is ignored, and filenames are stripped of paths and control characters.
- **Authorization.** Dispatchers and carrier managers may upload any type for their carrier. Drivers may upload only BOL/POD on loads currently assigned to them, re-checked after locking the load. Only dispatchers review. Drivers cannot see carrier compliance files. Foreign or guessed IDs return 404 and are audited by the route handler. Downloads are audited (`document.downloaded`) and served as `attachment` with `nosniff`, a sandbox CSP and `no-store`.
- **Idempotency.** Each upload carries an actor-scoped UUID. An exact retry returns the original version; the same key with different content returns 409. Re-uploading bytes identical to the current version returns `DUPLICATE_DOCUMENT_VERSION` instead of a new version. A per-slot row lock serializes version numbers.
- **Agreement link.** `carrier_dispatch_authorizations.document_version_id` is added as a nullable column (expand step). Agreement review in the UI now requires uploading the signed file. The server links only the *latest* agreement version for that carrier and records an accepted review in the same transaction. Older reference-only authorizations remain valid and are labelled "reference only".
- **Events.** Load paperwork events go to `load_events` (timeline + outbox). Carrier-level events reuse the carrier-bound `onboarding_events` stream rather than adding a third event table.

## Not decided / gaps

- No malware scanning. The UI states "Files are not virus-scanned yet"; scanning must be added before real operational use.
- Retention periods are not set. Nothing can be deleted through the application, and immutability triggers block UPDATE/DELETE. A retention/legal-hold policy needs legal review (record-keeping obligations differ for carriers and brokers).
- Insurance expiry is shown and drives reminders, but it does **not** gate booking. Only a current verified dispatch agreement gates booking or assignment (unchanged).
- Contract step for the agreement link (making a file mandatory server-side) is deferred until all carriers have a linked file.

## Rollback

Revert the application while keeping migration 005; the tables are additive. Do not drop `document_objects` — it holds the only copy of uploaded files.
