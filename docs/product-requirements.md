# Relay TMS — product requirements

## Who uses it

1. **Dispatcher:** assigned carrier accounts and loads, prioritization, exceptions, operational communication.
2. **Operations manager:** queues, performance, staffing, access/exception audit and escalations.
3. **Carrier administrator:** own trucks, drivers, loads, freight billing visibility and dispatch service invoices.
4. **Driver:** only assigned loads, stops, check-ins, document submissions, contact details.

## Must-have workflows

1. Onboard an authorized motor carrier with a verified signed agreement, scope and effective period.
2. Record a previously booked load against exactly one authorized carrier, including stops, rate confirmation and validated appointments.
3. Assign a driver/vehicle authorized by that carrier, then record dispatch and stop milestones.
4. Capture driver check-ins and provider observations with event time, source, precision, freshness and actor.
5. Open, triage, assign, resolve and audit exceptions without overwriting the shipment milestone state.
6. Capture and scan documents; track missing BOL/POD and versions; enforce carrier scope.
7. Prepare carrier billing packet; separately issue and reconcile dispatch service invoices.
8. Search/filter loads by status, owner, carrier, date and exception priority.
9. Surface next action and why it is due; show stale/unknown data rather than fabricated updates.

## Acceptance criteria for MVP

- Unauthorized carrier or driver access receives an actionable error and is audit-logged.
- Duplicate import and concurrent milestone updates do not create duplicate loads or lost history.
- Delivery can occur while POD is still missing and an exception remains open.
- Carrier freight invoice/payment is separate from dispatch service fee invoicing.
- Driver mobile view supports narrow screens, poor connections, retries and resumed uploads.
- Each load shows source/timestamp for check-in and ETA, with stale flag.
- All consequential changes appear in append-only domain events and audit history.
- All main actions have keyboard focus, accessible names, validation, and failure recovery.

## Non-goals for first release

Broker marketplace, independent freight allocation, payment custody, factoring, dispatcher's own fleet maintenance, machine-generated booking decisions, custom GPS hardware, native mobile app.

## Product success metrics

Minutes of dispatcher effort per load, missed check-ins, loads with open critical exceptions, on-time pickup/delivery, time from delivery to complete POD, time to billing packet, fee collection aging, user-reported workload and operational errors.
