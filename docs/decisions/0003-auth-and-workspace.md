# ADR 0003 — Shared login limits and a common queue behind both views

Status: implemented for QA; production controls still require review.

Per-process login throttles reset on a restart and differ across serverless instances. PostgreSQL now serializes per-identity attempt counters, keyed by a SHA-256 hash of the normalized email address. Eight attempts are allowed per minute. Password verification uses asynchronous scrypt so it does not synchronously block the request event loop. This does not replace edge-level IP throttles, MFA or a production identity provider. Expired counters are removed during subsequent attempts; session retention still needs a scheduled job.

Scope is applied inside the load SELECT before acquiring a write lock. Read-only detail requests do not acquire row locks. Assignment rechecks the carrier’s verified, effective agreement, in the same transaction as the assignment, event, outbox and version update. A retry of a prior create remains a read of its existing record.

Board and List use one authorized load queue and the same inspector/mutation contracts. Moving a card visually is not a status operation. Keyset pagination replaces offsets so new records do not duplicate older queue rows. Cursor tokens are opaque positions, not an authorization mechanism; each page reapplies membership scope. Clients must reset a cursor when filters change.

Migration 002 is additive and needs no backfill. Roll out the migration before application code. Rollback: restore previous application code and retain the additional table/indexes; do not delete audit, load or outbox data. No tenancy ownership, paid integration, deployment boundary or financial lifecycle changes are introduced.
