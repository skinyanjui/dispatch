# Repair operations runbook

This runbook accompanies the [authorized plan](2026-10-23-requested-plan.md) and [verification register](repair-status.md). Examples use the existing deployment; secret values belong in the provider's secret store, never Git, screenshots or chat.

## Deploy and identify the release

1. Push reviewed, tested commits to `main`; use the existing GitHub → Vercel integration. No additional hosting project is required.
2. Vercel must use `npm run build:vercel`. It applies migrations before building and stops on a migration error. Migrations 038 and 039 are additive. Leave `RELAY_QA_SEED` unset/false on databases with real data.
3. Confirm `DATABASE_URL`, `APP_ORIGIN=https://dispatch-nine-pearl.vercel.app`, `COOKIE_SECURE=true` and the existing encryption/session configuration. Remote PostgreSQL must trust the provider certificate and hostname. Do not turn TLS verification off to bypass an error.
4. Check `/api/health` returns 200. Compare `X-Relay-Revision` to the pushed Git SHA. A healthy older deployment is not evidence that the candidate deployed. If Vercel system variables are disabled, enable them or obtain the deployment commit from Vercel's build record.
5. As an owner/admin, inspect `/api/operations/status`: expected schema ends in `039`, release matches, and job history is current. This endpoint returns 401 signed out and 404 to unauthorized roles. Configuration flags indicate presence only.
6. Use a dedicated fictional QA account to verify sign-in, an authorized load, Reports, a precise drilldown and logout. Hosted passwords are independently configured; the workspace password is never copied automatically.

If a deployment fails, inspect its build log and correlated request ID. Preserve data and migrations. Prefer a compatible forward fix; see ADRs [0054](../decisions/0054-report-cohorts-and-durable-exports.md) and [0055](../decisions/0055-provider-receipts-and-operational-evidence.md) for rollback constraints. Do not run seeds or drop tables as a production repair.

## Establish the 15-minute trigger

The checked-in GitHub workflow is opt-in; Vercel's daily cron does not establish a sub-hourly trigger.

1. In Vercel Production, privately configure `CRON_SECRET` (at least 16 characters) and redeploy.
2. In GitHub → dispatch → Settings → Secrets and variables → Actions, set repository variable `RELAY_JOBS_URL` to `https://dispatch-nine-pearl.vercel.app` without a trailing slash. Set Actions secret `CRON_SECRET` to the same private value.
3. In Actions, run **Scheduler** manually. It calls `/api/jobs/notifications?scope=tick` with a bearer credential. A missing secret now fails visibly without calling the app. No URL means the workflow remains skipped.
4. Verify a successful `tick` in the authenticated Audit job status or `/api/jobs/status`; observe at least two scheduled executions approximately 15 minutes apart. GitHub schedules can be delayed. A run skipped because another holds the lock does not prove work completed.
5. Verify daily success separately. Tick becomes stale after 45 minutes; daily after 36 hours. The UI reports stale/failing/never; external alert delivery and on-call ownership must be configured separately.

Tick advances reminders, outbox delivery and pending exports. Enabling it may deliver previously queued messages if a real transport is configured: review provider settings, consent and queued work before enabling. This implementation did not configure production secrets or activate a trigger.

## Messaging and provider callbacks

Email acceptance needs the existing Resend sender/API configuration and `RELAY_DATA_KEY`; final delivery additionally requires an outbound webhook at `https://dispatch-nine-pearl.vercel.app/api/webhooks/email-status`, subscribed to delivered/failed/bounced events. Set its private `whsec_` value as `RESEND_WEBHOOK_SECRET`. This is separate from the existing custom inbound-email adapter and `RELAY_INBOUND_SECRET`.

Twilio requires the existing Account SID, Auth Token and permitted sender plus recipient consent. With an HTTPS `APP_ORIGIN`, sends automatically include a `StatusCallback` URL at `/api/webhooks/sms-status` with the delivery ID/attempt. Keep the full query intact when verifying signatures. The endpoint returns empty 204 after a verified receipt. Do not set a placeholder secret to make a capability flag appear enabled.

Before operational rollout, use an explicitly authorized provider sandbox/test recipient to exercise acceptance, delivery, failure and duplicate receipt. Confirm provider dashboards and Relay agree. No such external roundtrip was performed in this repair. Existing opt-outs, consent, suppression, attachments and scope checks remain authoritative.

For a lost send response, query `GET /api/messages/:message_id/result` or inspect the conversation; retry the same idempotency key to retrieve the saved operation. Do not blindly create a new send. Accepted means accepted by the transport; unknown means delivery cannot be determined. A confirmed SMS from an earlier attempt must not change a resend's result.

## Reports, exports and pagination

Report dates are inclusive UTC pickup dates. Invoice figures instead use issue dates and current balances. Drilldowns retain those bases in their URL. A failed refresh visibly labels retained results; retry before exporting the changed selection.

Direct CSV is complete up to 50,000 loads; larger results return `EXPORT_RANGE_TOO_LARGE`, with no partial file. **Larger exports** persists a job and its URL ID; reload resumes checking status. Jobs allow up to 500,000 rows and 64 MiB uncompressed CSV. Narrow the range above that bound. A user can hold three pending jobs. Crash leases can be reclaimed after five minutes; inspect job status rather than duplicating a request. A failed job requires a deliberate new request after correcting the cause.

Downloads expire after 24 hours, use the requesting actor's session, and recheck the original carrier manifest. A revoked membership yields 404; do not work around this with a shared public link. The worker clears expired artifacts. Job metadata/audit retention is separate and requires an operator-approved policy. Database storage and memory should be monitored before using upper export bounds; the local large-fixture test is not a hosted throughput benchmark.

Billing and Exceptions have explicit **Load more** controls; local filters and summary totals disclose their loaded-record basis. Report invoice drilldowns query the full issue-date cohort across authorized dispatcher carriers and paginate independently.

## Backups and restore verification

`npm run verify:restore` is intentionally restricted to loopback databases named `relay_qa*`, `relay_repair*` or `relay_test*`. Run it with a private QA environment loaded and a local PostgreSQL Docker container; optionally set `RELAY_TEST_PG_CONTAINER`. It creates an AES256-encrypted custom-format backup, removes the plaintext backup, decrypts/restores to a temporary database, compares all public table counts and checks the immutable-history trigger. Temporary files/database are removed afterward. Keep the source quiescent during the count comparison. CI runs this gate against its disposable `relay_qa` service.

This rehearsal does not establish production backups. Before real operations, assign an owner and documented RPO/RTO; enable encrypted offsite backups/PITR with retention, access logging and deletion policy; separate migration, application and backup roles; and rehearse a restore into a separate environment. Validate representative record contents, constraints, documents/object versions, encryption-key recovery and application sign-in, then record actual recovery time. Database-only row counts do not prove external document recovery. Ordinary immutability triggers do not protect against privileged database administrators.

## Monitoring and support

Capture `X-Request-Id`, route, time and `X-Relay-Revision` with a bug report. Keep credentials, document bodies, message contents and signed URLs out of support logs. API failures log sanitized kind/code, status and duration. Operations metadata and job history help identify schema or scheduler drift but do not replace error-rate/latency, database pool, export storage or provider backlog alerts.

Remaining rollout checks include independently configured alerts, least-privilege production roles, offsite restore, real bucket/scanner failure recovery, authorized provider delivery, and Firefox/WebKit/physical-device/assistive-technology review. They are tracked explicitly in the repair register.
