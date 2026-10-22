# 0009 — Separate carrier freight billing from dispatch-service invoices

Status: accepted, 2026-10-21.

## Context

Relay is a non-asset dispatcher acting as the carrier's agent. Freight charges are owed by the broker/shipper **to the carrier**. Relay's own revenue is a dispatch-service fee owed **by the carrier to Relay** under the dispatch agreement. Mixing the two would misstate who owns which receivable and risks implying custody of freight proceeds.

## Decision

Two independent schemas, state machines and screens:

1. **Carrier freight billing** (`carrier_billing_packets`, `carrier_payment_receipts`). One packet per load records the carrier's invoice number, bill-to party and amount (defaulting to the agreed rate).
   - Status is draft → submitted. Submission requires a delivered load and an accepted rate confirmation, BOL and POD. It records which document versions were in the packet.
   - "Submitted" records that the packet was sent outside Relay; Relay does not send it.
   - Receipts are append-only records of payments the carrier reports receiving. They cannot exceed the packet amount. Payment state (unpaid/partial/paid) is derived.
   - Dispatchers and carrier managers may manage packets; drivers have no access.
2. **Relay dispatch-service invoices** (`dispatch_invoices`, `dispatch_invoice_lines`, `dispatch_invoice_payments`).
   - Dispatcher-only. Each invoice covers delivered loads of one carrier, with a fee in integer basis points. Per-load fees are computed as `(amount × bps + 5000) / 10000` with BigInt/bigint (half-up), and the total is their sum.
   - A partial unique index allows a load on only one active (non-void) invoice. Invoice numbers (`RLY-####`) come from a sequence **at issue**, so drafts never consume numbers.
   - Draft → issued → void. An invoice with payments cannot be voided. Voiding releases its loads for re-billing.
   - Payments are append-only and cannot exceed the total.
   - Carrier managers can see their carrier's invoices.

All money is integer cents (`bigint`, ≤ 2^53−1 so JSON numbers stay exact; responses return strings). Each financial table uses optimistic versions or row locks plus actor-scoped idempotency keys. Packet events join the load timeline; invoice events join the carrier event stream; both have outbox and audit rows.

## Not included

No invoice PDF rendering, emailing, accounting export, factoring, quick-pay, accessorial line items, credit notes, tax handling or reconciliation against bank data. The fee rate is entered per invoice; it is not yet stored as an agreement term. Before live use, a qualified professional should review the dispatch fee basis and the record-keeping obligations.

## Rollback

Revert the application while keeping migration 007 (additive). Never delete receipts or payments; they are immutable records.

## Billing page polish

Styling only; no API, schema or permission change. The intro keeps one sentence ("Nothing here sends an invoice or moves money"), since each tab already describes its own table. The four summary tiles fill the row, the due date and its aging note read as two clean lines, and on phones each invoice or freight bill is a compact card: number first, then Status, Due, Total, Paid and Balance in two columns. Status filters wrap when a row is full and grow to fill it. An earlier phone rule for the Loads "needs attention" chips had leaked onto every chip row; it is now scoped to that strip.

## Addendum: no zero-fee invoices

A dispatch invoice needs a fee of at least 0.01% (1 bp) and a total above $0.00. A fee that rounds to nothing is refused with `FEE_TOO_SMALL`, because a zero total would read as paid the moment it is issued.
