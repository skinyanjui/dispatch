# 0054 — Report cohorts, snapshots and durable exports

Status: accepted, 2026-10-23

## Decision

Reports use inclusive UTC calendar dates for the first ordered pickup's window start. Cancelled loads are a separate count. Arrival performance is per stop, using its latest effective recorded arrival within both appointment boundaries. Unreported overdue stops are shown separately. These are reported observations, not inferred vehicle tracking.

Dispatch invoice figures use invoice issue dates and the current balances of those invoices. Payments are not restricted to the report period. Carrier freight figures use submitted billing packets in the pickup cohort and reported receipts; Relay does not hold those freight funds. The API returns basis descriptions and a transaction timestamp. All overview queries share a PostgreSQL REPEATABLE READ snapshot.

`reporting-scope.ts` owns date validation and pickup predicates. `document-readiness.ts` supplies the accepted current document predicate: a historical acceptance cannot satisfy a newer pending, rejected or expired version. Loads, exception queues and report invoice drilldowns enforce their own membership checks before applying the same cohort. Public URL filters are allowlisted; Back, Forward and reload retain them. Stale results retain their successful scope visibly and cannot be exported as the new selection.

CSV downloads are complete within explicit bounds: 50,000 rows synchronously, or a durable job of up to 500,000 rows and 64 MiB of uncompressed CSV. Exceeding a bound fails explicitly without a partial file. Formula-leading CSV cells are neutralized. Migration 038 adds actor-owned export jobs, retry keys, carrier manifests, leases, row counts and compressed artifacts. Creation serializes per actor to enforce a three-pending-job quota. Generation and download recheck membership; losing access to any carrier in the manifest denies download. Artifacts expire after 24 hours and are cleared by the worker. The scheduler and export requests can advance queued work; neither guarantees a configured production trigger.

Billing and exception APIs use stable server-side keyset pagination. Page summaries are labeled as loaded-record summaries. A linked invoice may be included beyond a normal page without consuming its continuation position.

## Verification

`repair-reconciliation.test.ts` exercises cohort reconciliation, current POD, invoice basis, snapshot isolation, 137 exceptions, billing beyond 100, a 5,103-row CSV, export retry/expiry/revocation, concurrent export quota and concurrent invoice payments. `repair-workflows.spec.ts` exercises navigation, stale recovery, download recovery and browser-only demo CSV. See [repair status](../repairs/repair-status.md) for the final run and its limits.

## Rollback

Expand-only schema; no existing financial or operational history is rewritten. Deploy readers supporting migrations 038–039 before enabling the new controls. If reverting application code, stop export claims and leave 038 and its audit records in place. Do not drop export tables or reverse migrations against live jobs. A forward correction is preferred; an operator may explicitly expire artifacts under the agreed retention policy.
