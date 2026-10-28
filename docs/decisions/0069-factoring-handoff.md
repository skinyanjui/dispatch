# 0069 Factoring handoff

Status: accepted, 2026-10-24.

## Context

Research found factoring is the common way small carriers turn invoices into cash, and that factors take invoices through file, SFTP or API handoffs. AGENTS.md requires clear consent, idempotency, retries, failure visibility and an audit record for external side effects, and Relay never holds freight proceeds.

## Decision

- **Relay sends nothing to a factor.** It prepares a schedule of invoices (a CSV) for the carrier to hand to its factor, and records that the carrier did. A live integration would be a later decision with its own consent, retry and failure handling; this keeps the data model (batches, lines, hashes) it would need.
- **Consent** (`carrier_factoring`, migration 045): only a carrier manager of that carrier can switch it on, naming the factor and giving explicit consent; the database refuses an enabled record without factor, person and time. Dispatchers and other carriers' people get 404. Changing the factor's name asks for consent again.
- **Eligibility** is derived, never typed: delivered, billing packet submitted, rate confirmation, bill of lading and proof of delivery all accepted, not fully paid, and not already in an active batch. The overview shows each load with the reason it is not eligible.
- **Payout details must be in force** (ADR 0064): none recorded, or still cooling off, refuses the batch.
- **Batches** (`factoring_batches`, `factoring_batch_loads`) store the exact file and its SHA-256, the payout change they relied on, and the person and time. Creating is idempotent by key (same key and body replays; same key and a different body is a conflict); a load is in one active batch at a time (unique partial index). Lifecycle: prepared, handed off (the carrier says it gave it to the factor), void (with a reason; releases the loads, also after handoff).
- **File:** `carrier_invoice_number, load_reference, bill_to, amount, currency, delivered_on, invoice_submitted_on, documents`. Amounts are exact decimal text from minor units; spreadsheet formulas in cells are neutralised. Downloads are audited and carry `X-File-SHA256`.
- Audit: `factoring.enabled`, `.disabled`, `.batch_prepared`, `.batch_downloaded`, `.batch_handed_off`, `.batch_voided`.

## Consequences

Whether a given factor accepts this layout is not verified; the columns are a neutral schedule and a factor-specific format would be a mapping on top. Relay cannot tell whether the factor received or funded the schedule, so it records no funding; the carrier records receipts as before (ADR 0007). Rollback: leave the tables and remove the routes.
