# 0010 — Automatic notification delivery through an encrypted outbox

Status: accepted, 2026-10-21.

## Decision

Messages are written to a `notifications` table **inside the same transaction** as the change that causes them:
- invitations, queued when the invite is created;
- driver assignment, sent to the assigned driver's user;
- exception ownership, sent to the new owner unless they assigned themselves.

So a rolled-back change never emails, and a committed change is never lost. A unique `dedupe_key` makes enqueueing idempotent.

- **Content protection.** Bodies can contain private invitation and reset links. They are sealed with AES-256-GCM using `RELAY_DATA_KEY` and set to NULL after delivery. Failed messages keep the sealed body for 7 days so they can be retried, then it is purged. Recipient, subject, status and errors remain as a delivery log. Without a key, messages are recorded as `suppressed` with the reason shown; nothing is silently dropped. The copy-link flow for invitations still works.
- **Delivery.**
  - `deliverDue()` claims due rows with `FOR UPDATE SKIP LOCKED` and a 2-minute lease, so concurrent workers never double-send and a crashed worker's claim expires.
  - Retries back off at 1, 5, 15, 60 and 240 minutes; after 6 attempts, or on a permanent 4xx (except 429), the message is `failed`. Dispatchers can re-queue failed messages for their organization (audited).
  - The Resend transport passes the notification id as `Idempotency-Key`, so provider-side retries are deduplicated.
- **Triggers.** After any successful POST, the route schedules `deliverDue(10)` with Next.js `after()`. A daily Vercel Cron (`/api/jobs/notifications`, `Authorization: Bearer $CRON_SECRET`, compared in constant time) queues reminders and drains the queue. Hobby-plan crons are daily; a paid plan or external scheduler can run it more often.
- **Reminders** are deduplicated per period:
  - POD not accepted 24 hours after delivery, daily, to the carrier's dispatchers and managers;
  - insurance expiring within 30 days or expired, weekly;
  - overdue exceptions, daily, to the owner.
- **Transports.** `RELAY_EMAIL_TRANSPORT` = unset/`none` (record only, marked "not sent"), `log` (development; logs id/subject only, shown as "log only"), or `resend` (`RESEND_API_KEY`, `RELAY_EMAIL_FROM`). Nothing is configured in this repository, so no email is sent.
- **Preferences.** Users can mute operational kinds (assignment, exception assignment, reminders). Invitations, password resets and verification emails cannot be muted.
- **Privacy.** The delivery log is visible only to dispatchers, for their organizations. Account-security messages have no organization and never appear there.

## Not included

SMS, push, digests, per-carrier sender domains, bounce/complaint webhooks and quiet hours. Email requires a verified sending domain and consent review before production use.

## Rollback

Revert the application; keep migration 008. Pending rows stay queued and are not delivered until a worker runs again. To stop delivery immediately, unset `RELAY_EMAIL_TRANSPORT`.
