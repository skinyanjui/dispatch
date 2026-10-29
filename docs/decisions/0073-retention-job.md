# 0073 Retention job

Status: accepted, 2026-10-29. Builds on ADR 0072 (item 4). Migration 049 is expand-only.

## Decision

1. **Period.** `RELAY_RETENTION_YEARS`, default 7, never below 1. The default is a placeholder for a period to be chosen with counsel; changing it needs no code.
2. **What goes.** (a) The CSV file of a handed-off or cancelled factoring schedule older than the period: `file_csv` is cleared and `file_purged_at` set; the hash, load count and total stay, and downloading says `FILE_PURGED` (410). (b) Registration lookups older than the period, except each carrier's newest lookup and newest successful one.
3. **What stays.** Claim evidence and packets, invoices, load events, audit rows, notifications' delivery log and payout change history. They are financial or audit records; no period was chosen for them and the job does not touch them.
4. **How.** A daily step (`retention`) in the notification job. Every purge writes an audit row (`retention.factoring_file_purged` per schedule, `retention.authority_checks_pruned` per carrier); the run returns counts, so a job that does nothing is visible in the job record.
5. **Append-only stays.** Lookups remain undeletable and uneditable except that a delete inside a transaction that sets `relay.retention=on` is allowed (migration 049 replaces the trigger function; updates are still refused). Anyone with database access could set that, as they could already drop the trigger: this is a guard against application mistakes, not a control against a database administrator.

## Consequences

A carrier that asks for erasure still needs a manual, audited process; this job is age-based housekeeping, not erasure. Purged files cannot be restored except from backups, which have their own retention (see the backup runbook). Rollback: remove the `retention` step; leave the column and the trigger function.
