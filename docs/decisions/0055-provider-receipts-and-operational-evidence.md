# 0055 — Signed delivery receipts and operational evidence

Status: accepted, 2026-10-23

## Decision

An outbound transport response means provider acceptance, not delivery. Message responses add an operation ID, processing state and recipient outcomes while preserving existing identifiers. Retry of the same request returns its persisted result; a separate authorized result endpoint reconciles lost responses without sending again. Unconfigured email/SMS fails explicitly. A provider timeout is unknown and requires deliberate reconciliation or the existing explicit resend confirmation.

Migration 039 stores immutable, deduplicated provider receipts. Twilio signs the canonical full callback URL and every form parameter with its Auth Token. Resend delivery events use the endpoint's native Svix signatures, event IDs and bounded timestamps. Signature checks precede storage. Twilio receives an empty HTTP 204 acknowledgment. Callbacks contain no browser session or CSRF exception usable as an authenticated application action.

Twilio callbacks carry a signed delivery ID and attempt number, permitting reconciliation after a lost acceptance response. Row locks bind them only to that exact attempt. A resend resets the provider reference, so an earlier attempt cannot change the new attempt. Early Resend receipts can remain unassociated until their provider message ID is persisted. Projections match that provider ID and preserve delivery confirmations over delayed acceptance/failure events. Matched receipts get organization-scoped audit records. An unmatched signed receipt is not exposed as a cross-tenant record.

The Inbox distinguishes recorded, queued, accepted, failed, unknown, suppressed, partial and confirmed delivery. Only in-app availability says “available in Relay”; external delivery requires a verified provider receipt. Notifications likewise distinguish acceptance from confirmation. No live send or provider enablement is part of implementing this change.

Every API response has a request correlation ID. Production responses expose the Vercel Git revision when available. The owner/admin operations endpoint shows schema, release, configuration-presence flags and job history without secret values. Presence is not a provider connectivity test. Unexpected API errors log a kind/code rather than raw exception messages.

Remote PostgreSQL connections select certificate/hostname-verified TLS explicitly; remote `sslmode=disable` is refused. This can expose a previously hidden certificate misconfiguration: install the provider's trusted CA or use its supported verified endpoint, rather than disabling verification.

## Verification and operations

Signed, tampered, duplicate, out-of-order, early and lost-acceptance callbacks are exercised with fictional local fixtures in `provider-status.test.ts`. Existing inbound tests retain their original security assertions; tamper fixtures always change their token. Browser receipt responses are mocked, so no external delivery is claimed. [The runbook](../repairs/operations-runbook.md) covers provider setup, trigger verification, backups and release checks.

## Rollback

Leave 039 and receipts intact. An older application can ignore the table but will no longer display confirmed outcomes accurately. Disable new outbound actions/callback routing before reverting to such readers, or deploy a compatible forward fix. Never rewrite immutable receipts to make an old status appear successful. TLS failures should stop deployment and be corrected before traffic is restored.
