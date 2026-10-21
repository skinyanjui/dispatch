# Documents, exceptions, billing, accounts and notifications — 2026-10-21

Baseline: `0b83d93`. The scope was the five gaps the user identified:
- agreement review recorded a reference only;
- there was no exception management;
- carrier billing and dispatch invoicing were mixed or absent;
- account administration was missing;
- invitations had to be copied by hand.

## Audit findings at baseline

| Area | Finding |
| --- | --- |
| Documents | No upload, storage, versioning or review existed. Dispatch authorization stored a free-text reference with no file. The load inspector stated "Delivery does not mark documents complete", but there was nothing to complete. |
| Exceptions | No table, API or UI. Missed appointments and missing paperwork could not be flagged, owned or resolved. |
| Billing | No financial records. The build plan required separate carrier billing and dispatcher invoice lifecycles; neither existed. |
| Accounts | Login only. There was no recovery, verification, MFA or way to remove access. Organizations were implicit in dispatcher memberships and could only be created by the seed. |
| Notifications | The outbox had no consumer. Invitation links had to be copied manually. No reminders existed. |

## Changes (one commit each)

1. **Documents** — migration 005, [ADR 0007](../decisions/0007-documents-and-compliance.md).
   - Immutable versions and reviews, with content-sniffed PDF/PNG/JPEG up to 4 MiB.
   - Carrier compliance files (agreement, auto liability, cargo, W-9) with insurance expiry, plus load paperwork (rate confirmation, BOL, POD).
   - Audited downloads.
   - Agreement review now uploads the signed file and links the exact verified version.
2. **Exceptions** — migration 006, [ADR 0008](../decisions/0008-exception-management.md).
   - Flag, assign, start, resolve and reopen, with optimistic versions and timeline events.
   - Drivers can report on assigned loads.
   - A queue view, plus suggestions from recorded data that are never auto-created.
3. **Billing** — migration 007, [ADR 0009](../decisions/0009-separate-billing-lifecycles.md).
   - Carrier freight packets are gated on delivery and accepted paperwork, with carrier-reported receipts.
   - Relay dispatch invoices use basis-point fees, single-billing per load, numbering at issue, void and payments.
   - All money is integer cents.
4. **Notifications** — migration 008, [ADR 0010](../decisions/0010-notification-delivery.md).
   - Transactional, encrypted email outbox for invitations, assignments, exception ownership and reminders.
   - SKIP LOCKED delivery with bounded backoff, delivery log with retry, and user preferences.
5. **Accounts** — migration 009, [ADR 0011](../decisions/0011-account-administration-and-tenancy.md).
   - Password reset and email verification.
   - TOTP MFA with recovery codes.
   - Password change, organization admins and profile, team removal, and the `org:create` bootstrap.

## Defects found and fixed during this work

- A scripted route edit silently missed after formatting, which left the billing-packet endpoints unrouted. It was caught by an HTTP integration test, and every scripted edit after that asserts it applied exactly once.
- MFA audit inserts reused one SQL parameter as both uuid and text (`42P08`). Found by the MFA integration test and fixed.
- The document upload button and file input had overlapping accessible names ("Upload" and "Upload file"). The button is now "Upload {document}".
- The billing list showed every load. It now defaults to delivered loads or loads with a packet, with a toggle.
- Notification tests are written against per-row state, because integration files run concurrently and share the outbox.

## Verification (local, fictional QA data)

- Lint, TypeScript and the production Next.js build pass.
- Unit/integration: **63 pass**, 0 skipped. New files: documents 6, exceptions 4, billing 4, notifications 6, account 6. They cover cross-carrier and guessed-ID denial, driver scope, idempotent retries, immutability triggers, money rounding and limits, token single use, MFA replay and attempt limits, and team-removal rules.
- Browser (Chromium): **40 pass**. Six new tests cover document upload/reject/version/accept/download, exception flag-from-suggestion through queue to resolution, billing packet + invoice issue/payment and driver denial, MFA enrollment and recovery-code sign-in, forgot-password non-enumeration, and the demo making no server calls. Existing onboarding/demo tests were updated for the agreement file upload.
- Migrations 005–009 applied to the existing local QA database. The deployment test migrates an empty database twice.
- Screenshots: `evidence/ops-*.png`, desktop 1440 px and phone 390 px (no horizontal scroll).

## Operational notes

- New environment variables:
  - `RELAY_DATA_KEY` — required for email bodies and MFA; without it both fail closed and say so.
  - `RELAY_EMAIL_TRANSPORT`, `RESEND_API_KEY`, `RELAY_EMAIL_FROM` — no email is sent unless these are set.
  - `CRON_SECRET` — for the daily job added to `vercel.json`.
- No deployment, paid service or email provider was configured.
- Run `npm run db:migrate` before starting this version.

## Remaining gaps

- No malware scanning, and no object storage or signed URLs yet.
- No retention policy (needs legal review).
- No dispatcher/admin invitations, email change, enforced MFA or session management UI.
- No invoice PDF/email, accounting export or bank reconciliation.
- No SMS, bounce webhooks or delivery-rate monitoring.
- The billing overview reads document readiness per load, which is fine at 100 rows but should be batched before scaling.

This was a focused engineering audit with automated tests. It was not a penetration test, a screen-reader certification or a legal/regulatory review.

## Follow-up: storage, scanning and workflow limits

Requested next: malware scanning and object storage, plus the workflow limits (one pickup and one delivery per load, no check-in correction, no older-history browsing).

- **Storage and scanning** ([ADR 0012](../decisions/0012-object-storage-and-malware-scanning.md), migration 010):
  - Write-once S3-compatible storage with built-in SigV4 signing, which reproduces AWS's published S3 signatures exactly.
  - A ClamAV `clamd` INSTREAM client. Infected files are logged and never stored; scanner errors fail closed.
  - Downloads use 60-second signed URLs.
  - A verified, resumable PostgreSQL-to-bucket migration (`npm run documents:migrate-storage`).
- **Multi-stop loads:** 2–10 ordered stops ([ADR 0013](../decisions/0013-multi-stop-and-check-in-history.md)).
  - While adding this, the existing malformed-stops test caught a crash on an empty stops array: the ordering check ran even after the count check failed. It was fixed before the commit was pushed.
- **Check-in amendments and older history** (migration 011): append-only corrections and retractions, plus cursor paging for events and check-ins.

Verification on the final code:
- Lint, TypeScript and the production build pass.
- **75** unit/integration tests pass. New: object storage and scanning 6, multi-stop 3, history 3.
- **43** Chromium tests pass. New: multi-stop creation, correct then retract, and older activity/check-in paging.

No live bucket or ClamAV daemon was reachable here: there is no Docker daemon, and the proxy blocks image and signature downloads. Storage is verified against AWS's published signature vectors and an in-process fake S3 server; scanning against a fake `clamd` that speaks the real INSTREAM protocol, including the EICAR test string. Run one upload against your real bucket and ClamAV before enabling `RELAY_REQUIRE_MALWARE_SCAN=true` in production.

## Follow-up: direct-to-bucket uploads

Files over 4 MB now upload straight to the bucket (up to 25 MB), then the server verifies size, checksum and type, scans, and records them ([ADR 0015](../decisions/0015-direct-to-bucket-uploads.md), migration 013). The 4 MB server path is unchanged.

- **Verification:** lint, TypeScript and the production build pass; **85** integration tests pass (7 new) and **45** Chromium tests pass (1 new).
- **Test fidelity:** the S3 stand-in recomputes presigned signatures as S3 does, which proves the PUT is bound to the declared size and validates the SigV4 signer. No live bucket or ClamAV was available.
- **Needs configuration:** bucket CORS (PUT from the app origin), a lifecycle rule expiring `quarantine/`, and a `clamd` stream limit of at least 25 MB.
- **Limits:** not resumable (a failed upload restarts), and 25 MB maximum.

## Follow-up: staff invitations, contacts and inbox

Reviewed as a dispatcher, a driver and a carrier manager: what is missing day to day.

- **Added:** dispatcher/admin invitations ([ADR 0016](../decisions/0016-staff-invitations.md)); a searchable Contacts directory with quick connect ([ADR 0017](../decisions/0017-contacts-directory.md)); an Inbox with Relay messages, email, consent-gated text, hand-logged calls, unread badge, search and saved replies ([ADR 0018](../decisions/0018-inbox-and-messaging.md)).
- **Found while testing:** a thread stores a driver as `user:`, but the directory lists them as `driver:`, so a dispatcher replying to a driver-started thread got `NOT_FOUND` and the composer showed email, text and log options to drivers who are not allowed to use them. Both are fixed and covered by tests.
- **Closed in the next round:** load edit and cancel, reporting, inbound email/text with STOP handling, resending failed texts, message attachments, and driver appointment reminders (ADRs 0019–0024).
- **Still missing:** inbound attachments, MMS, per-tenant phone numbers, provider adapters for inbound email, cost/profitability reporting, abandoned-upload cleanup, and a 15-minute scheduler for two-hour reminders.
- **Not verified live:** no email or SMS provider is configured here. Texts are tested against an in-process fake provider; the demo never sends.
