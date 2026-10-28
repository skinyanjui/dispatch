# 0068 Paperwork readiness with an owner for every gap

Status: accepted, 2026-10-24.

## Context

Research found that complete paperwork starts the payment clock and that carriers and dispatchers lose days to not knowing whose move it is. Relay already prevents a billing packet from being sent until the rate confirmation, bill of lading and proof of delivery are accepted (`DOCUMENTS_NOT_READY`) and shows each slot's status per load, but a person had to open every load to find what was missing and who had to act.

## Decision

- `GET /api/documents/readiness?carrier_id=` lists the carrier's open loads (newest 200, cancelled excluded) that still have a required document outstanding, each with the items to act on.
- Rules (`readiness-rules.ts`, shared with screens and the demo): a missing or rejected rate confirmation is the dispatcher's to supply; a missing or rejected bill of lading or proof of delivery is the driver's; any document waiting for review is the dispatcher's. An item blocks billing only once the load is delivered; earlier loads are listed, with the later documents simply not due yet. Accepted and expiring documents are done.
- Each item states the action in the owner's terms ("Upload a corrected proof of delivery", "Review the proof of delivery"). Held-up loads sort first, then longest outstanding (whole UTC days since the delivered milestone).
- **Audience:** dispatchers and carrier managers see the carrier's loads; a driver of that carrier sees only their assigned loads and only the items that wait on drivers; other carriers' people get 404.

## Consequences

Nothing new is stored and no rule changes; this is a read model over the existing document slots, so it cannot disagree with the billing gate. Reminders to the owner (messages) are not added here, since they would need consent and delivery handling (ADR 0046). Rollback: remove the route.
