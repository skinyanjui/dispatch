# 0067 Detention and TONU evidence

Status: accepted, 2026-10-24.

## Context

Research found detention is mostly unpaid (carriers invoice it but are paid on a minority of invoices, per secondhand ATRI and OOIDA figures that were not verified from the primary reports) and that unprovable timing is a main reason. Relay already records per-stop arrival and departure reports with their author and time (ADR 0020), flags long stops, and tracks cancellations, but did not turn that into a claim a payer can check.

## Decision

- **Terms** (`detention_terms`, migration 044) per load: free minutes, hourly rate, optional cap, optional TONU fee, and where the terms came from (`rate_confirmation`, `agreement`, or `verbal`, which the packet states plainly). Terms cannot change while a claim on the load is open.
- **Arithmetic** (`accessorial-rules.ts`, shared with screens and the demo): free time starts at the later of the truck's arrival and the opening of the appointment window; the clock stops at departure; billable minutes are those beyond free time, up to any cap; the amount is the hourly rate pro rata, rounded half up, in integer minor units. A late arrival (after the window closed) is shown as a note for the reader, not used to refuse the claim, since contracts differ.
- **Evidence is frozen.** A claim (`accessorial_claims`) copies the stop's reports (every report and correction, who recorded it, when it happened, when it was recorded, all labelled as manual reports), the terms and the calculation at the time it was started. A draft can be refreshed (for example after a correction); once submitted the evidence does not change. Flags travel with it: times were corrected, a time was recorded more than a day after it happened, arrival after the window.
- **No invented claims.** Detention needs terms, an arrival and a departure and a positive amount; TONU needs a cancellation after dispatch and before pickup and a TONU fee stated in the terms (the amount is never typed in freehand). One open (draft or submitted) claim per load, kind and stop; a paid or denied claim frees the slot.
- **Lifecycle:** draft, submitted (the carrier sent it), then paid (with the amount received, never more than claimed) or denied. Relay prepares the packet; the carrier is the claimant and reports the outcome. `GET /api/claims/:id/packet` returns a PDF built from the frozen evidence. Dispatchers and carrier managers of the carrier only; everyone else, including drivers, gets 404.
- **Audit:** `claim.terms_set`, `.created`, `.refreshed`, `.submitted`, `.paid`, `.denied`.

## Consequences

Times are reports entered by people, not telematics readings; the packet says so. No geofence or ELD evidence is attached (see the research notes on tracking claims). A payer can still dispute terms: `verbal` terms are marked as such. Rollback: leave the tables and remove the routes.
