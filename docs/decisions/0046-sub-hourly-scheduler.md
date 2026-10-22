# 0046 Sub-hourly scheduler

Status: accepted

## Decision

The scheduled notification job (`GET /api/jobs/notifications`, bearer `CRON_SECRET`) takes a `scope`:

- `tick`: appointment reminders (the two-hour tier is why this must run often) and delivery of queued messages and their retries.
- `daily` (also the default with no scope, so existing callers behave as before): the tick work plus proof-of-delivery, insurance and overdue-exception reminders, abandoned-upload cleanup, and pruning of run records older than 30 days.
- Any other scope is a 400.

Every step is already idempotent (dedupe keys, `SKIP LOCKED` claims), so late or repeated triggers are harmless. A Postgres advisory lock per scope stops two runs of one scope from overlapping; a caller that loses gets `{ "skipped": "running" }` and leaves no record. Every other run writes one `job_runs` row (outcome, duration, counts, or a short error message of at most 200 characters; never message text) and failures are also logged as `job.failed` and returned as an error to the caller.

**What triggers the tick is a deployment choice.** Vercel's own cron stays daily because sub-daily crons are refused on the Hobby plan and a refused cron would fail the deploy. For every 15 minutes use any one of: a Vercel Pro cron, an external pinger, or `.github/workflows/scheduler.yml`, which does nothing until the repository variable `RELAY_JOBS_URL` and the secret `CRON_SECRET` are set. Nothing is scheduled, deployed or paid for by this change.

`GET /api/jobs/status` (a signed-in organization owner or admin; 404 for everyone else) returns, per scope, state, last run, last success, last duration and the stale threshold. States: `ok`, `failing` (last run errored), `stale` (no success within 45 minutes for tick, 36 hours for daily) and `never`. A tick that has never run is `never`, not an alarm, because the 15-minute trigger is optional. Counts are not exposed because they span organizations.

## Consequences

Migration 035 adds `job_runs` (expand only; rollback is `DROP TABLE job_runs`). `scheduleReminders` is split into `scheduleDailyReminders` and `scheduleAppointmentReminders`; the old function still runs both. The audit page shows the status (ADR 0047).

Not done: no alert is sent when a scope goes stale (the page shows it); the lock is per database, which is right for one database and one deployment.
