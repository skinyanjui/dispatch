# Backend connectedness and calculation audit — 2026-10-22

Scope: API route → `src/lib` module → table wiring, the end-to-end money flow,
and every calculation the product displays. Method: code reading, 33 SQL
integrity probes against the QA database (1,000+ loads, 380+ invoices), and a
new cross-module reconciliation test.

## Flow checked

carrier authorization → booked load → assign (driver/vehicle belong to the carrier)
→ milestones (strictly sequential, assignment required) → documents accepted →
carrier billing packet (delivered + all slots accepted) → carrier receipts
(never above the packet) → dispatch invoice (dispatcher only, delivered loads,
one active line per load) → issue (number from a sequence) → payments (never
above the total, only on issued invoices) → void (blocked once paid, releases
the loads) → reports.

Every step takes `scoped()`/membership checks inside the transaction, locks the
row it changes, and writes `load_events` or `onboarding_events` plus an
`outbox_events` row and an `audit_logs` row.

## Findings and fixes

| # | Finding | Result |
|---|---------|--------|
| 1 | Report ranges, weekly buckets, overdue-invoice test, audit date filters and the insurance-expiry reminder compared UTC dates against the database session timezone. On a non-UTC database a Monday 02:00 UTC pickup landed in Sunday's range and the previous week. | Fixed: every boundary is now explicit UTC (`… AT TIME ZONE 'UTC'`). Test `utc-ranges.test.ts` runs the report with the session in Los Angeles; it failed before and passes now. |
| 2 | Two exports were dead (`inboundConfigured`, `knownAuditActions`). | Removed. |
| 3 | No test tied reports, billing overview and raw SQL together. | Added `flow-reconciliation.test.ts`: fee rounding (half-up, $1,234.57 × 8.5% = 10494), invoice total = sum of rounded lines, partial payments, overdue count, carrier freight billed/received/outstanding, weekly and per-carrier totals, delivered-without-POD, and the manager view hiding dispatcher fees. |

## Checked and sound

- Money is integer minor units end to end; sums use `BigInt`; fee = `(amount × bps + 5000) / 10000`.
- Invoice totals equal the sum of their lines (0 mismatches on real flows; 348 QA fixture invoices were inserted directly by volume tests without lines and are not produced by any code path).
- No invoice line, packet, receipt, document, exception, event, check-in, driver or vehicle crosses carriers (all probes 0).
- Payments and receipts never exceed their totals; none exist on draft/void invoices or unsubmitted packets.
- No load is invoiced twice while active; invoiced loads are all delivered; cancel is only possible before pickup so a cancelled load can never carry an invoice.
- Cancelled loads reject writes (`LOAD_CANCELLED`).
- Audit rows with no organisation are system or inbound events (rejected email/SMS, opt-outs, cleanup), as designed.
- Only table with no application reference is `schema_migrations` (migration runner).

## Known gaps, not changed here

- `outbox_events` has no consumer yet (ADR 0049); events accumulate until integrations exist.
- Billing overview loads document slots per load (up to 100 queries); correct, but a candidate for one batched query.
- `fee_bps = 0` is accepted and produces a zero-total invoice that reads as "paid" once issued; decide whether to reject it.
- Dispatch-invoice `overdue` and report ranges use UTC dates, not the carrier's local date.
