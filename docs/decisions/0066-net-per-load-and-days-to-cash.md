# 0066 Net per load and days to cash

Status: accepted, 2026-10-24.

## Context

Research found two things carriers distrust: percentage dispatch fees they cannot see the effect of, and cash that waits on paperwork. Relay already keeps carrier freight billing (packets, receipts) and dispatcher fee invoices as separate lifecycles (ADR 0007) but never showed a carrier what a load earned after the fee, or where its money was stuck.

## Decision

- `GET /api/billing/cash?carrier_id=` (dispatchers and carrier managers of that carrier; others 404) returns each delivered, non-cancelled load (newest 200) with: gross, the dispatch fee, net, a cash stage, who it waits on, the dates, and days.
- **Fee is never invented.** `invoiced` is the real fee on the load's active dispatch invoice line, with its basis points; `estimate` appears only when the caller passes `fee_bps` to preview a percentage; otherwise `unknown` and net is null. The summary's net counts only loads whose fee is known and says how many (`net_loads`).
- **Stages** (`src/lib/cash.ts`, shared with screens and the demo): not delivered, waiting for proof of delivery (driver), ready to bill (dispatcher), waiting for payment or partly paid (payer, named from the packet's bill-to), paid. Paid means the carrier's recorded receipts reach the packet amount; the paid date is the date they first did.
- **Days** are whole UTC calendar days: delivery to submitted packet, submitted to paid, delivery to paid, and for unpaid loads the days waiting since submission (or delivery). The delivery date is when the load's `delivered` milestone was recorded.
- Money is integer minor units as strings; fees round half up with integer arithmetic (`feeOf`); no floating point.
- Relay still does not hold freight proceeds: receipts are what the carrier reports.

## Consequences

Days to cash depends on receipts being recorded, so loads whose receipts are missing look unpaid; the screen says paid means "recorded". A per-carrier default fee is not stored (the fee is chosen per dispatch invoice), hence the preview. Rollback: remove the route; nothing is stored.
