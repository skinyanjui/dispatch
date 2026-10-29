# 0074 Carrier erasure on request

Status: accepted, 2026-10-29. Builds on ADRs 0064 (change control), 0072 and 0073 (retention). Migration 050 is expand-only.

## Decision

1. **Who and how.** Only an owner or admin of the carrier's organization can ask, by typing the carrier's name and their password (and a code if they use two-step verification). A different owner or admin must approve, naming how they confirmed it and entering their password again. This is the existing change-control path (`kind: carrier_erasure`): separation of duties is a database check, requests lapse after seven days, and the other administrators are notified. Carrier managers and dispatchers who are not administrators cannot ask, decide or see it.
2. **Blocked while work is live.** Active (undelivered, uncancelled) loads, open claims (draft or submitted) and prepared factoring schedules block both the request and the approval (`CARRIER_HAS_OPEN_WORK`).
3. **What it does.** In one transaction it replaces the carrier's name with "Erased carrier ...", sets `carriers.erased_at`, ends its dispatch authorization (no new freight), cancels other pending requests, and applies the categories below.
4. **Categories and the keep list.** Erasable: people (drivers, vehicles, team, invitations, contact person), contacts and prospects, messages, notes (load, check-in and stop-time free text), documents (names, scan names, AI-read values, stored bytes), registration lookups, payout details (and names in change requests). Always kept, because this tool cannot erase them: loads and their history, invoices and payments, claims, factoring schedules, the audit trail. `RELAY_ERASURE_KEEP` (a comma list of category ids) lists what to keep; unset means the defaults, which keep only the non-erasable ones; it can widen what is kept, never narrow it below those. Unknown ids are ignored.
5. **Files.** Bytes stored in the database are emptied and the object marked purged. Files in a bucket are queued (`erasure_object_deletions`) and deleted by the job, retried until the store confirms; failures are recorded and visible. Downloads of purged files answer `FILE_PURGED` (410). Hashes and sizes stay.
6. **Receipt.** The request row becomes the receipt: what was erased and kept, with row counts, and an audit event `carrier.erased`. Audit rows are not edited.
7. **Append-only stays.** The history tables scrubbed here (notes, check-ins, stop times, document versions and scans, membership removals, onboarding events, registration lookups) can be changed only inside a transaction that sets `relay.erasure=on`, as with the retention job (ADR 0073); anyone with database access could set that.

## Limits (stated, not hidden)

- Load history and event payloads are kept and can still contain names someone typed (stop addresses, event text). They are business records of freight moved; revisit with counsel if a payload must be scrubbed too.
- Invoices, payments and claims keep their amounts and references. The carrier's name on them reads "Erased carrier".
- Backups keep what they had until they age out (see the backup runbook). Erased data is not recoverable from the application.
- Self-attested checks (the approver says how they confirmed the request) are statements, as in ADR 0072.
- Whether a record may legally be kept is a legal question; the default keep list is a starting point, not advice.

## Consequences

Erased carriers disappear from everyone's carrier lists (their memberships are gone) and cannot be booked. Undoing needs a backup restore. Rollback: leave the column, table and functions; remove the route and screen.
