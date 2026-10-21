# Relay Dispatch TMS — Build plan

**Current stage:** Authenticated, carrier-scoped foundation with persistent load creation, assignment, milestones and manual check-ins. The operational MVP remains incomplete; exceptions, documents, finances and integrations are pending. The prototype workflows below remain a historical reference. All sample data is fictional. Nothing is submitted to a carrier, broker, driver, telematics service, or payment processor.

## What works in the prototype

- Prioritized dispatch work queue; overview, load, exception, document, and billing views
- Carrier filtering and load search; responsive mobile load cards
- Booked load creation with required carrier, route, appointments, rate, and fee
- Carrier-specific driver assignment, dispatch milestone progression, and manual check-ins
- Open/resolved exceptions with a history event
- Rate confirmation/BOL/POD receipt flags (not real document uploads)
- Separate carrier billing-packet and dispatch-service-invoice statuses
- Internal notes and event timeline
- Local browser storage; reset to original demo data

## Recommended production architecture

A **modular monolith** with one service boundary for dispatch operations. Build with Next.js/TypeScript, authenticated server routes, PostgreSQL, object storage for documents, a durable background job queue, and an outbox for external events. No microservices needed at launch.

### Core domains and data model

- `organizations`, `users`, `memberships`, `roles` — internal dispatch organization and carrier organizations
- `carriers` (authority reference, verification status), `carrier_dispatch_authorizations` (effective dates, scope, signed agreement reference)
- `drivers`, `vehicles`, `carrier_driver_assignments`
- `loads` (stable ID, source, external reference, carrier, equipment, agreed amount in minor units, currency, dispatcher, stage, version)
- `load_stops` (ordered pickup/delivery/other stop records with time zone, time window, address, contact and confirmation)
- `load_assignments`, `check_ins`, `tracking_observations` (provenance and timestamp)
- `documents` (type, storage key, status, uploader, checksum, scan result, version, retention)
- `exceptions` (type, severity, status, owner, due time, resolution)
- `load_events` (append-only actor, timestamp, event type, source, structured payload)
- `carrier_billing_packets`, `dispatch_invoices`, `payments` (separate financial lifecycles)
- `messages`, `notification_attempts`, `outbox_events`, `integration_connections`, `audit_logs`

All carrier-bound tables must include an authoritative carrier linkage. Enforce relational constraints and indexes on `(carrier_id, status, timestamp)`, external references, stop sequence, and exception ownership. Use integer money minor units or fixed-precision database decimal, never floating-point accounting values.

### API contract examples

- `POST /api/loads` — create a load for an authorized carrier, validate document/source, appointments, idempotency key and duplicate references
- `GET /api/loads?carrier_id=&status=&cursor=` — carrier-scoped, paginated work queue
- `GET /api/loads/{id}` — full operational workspace with timeline and authorizations
- `POST /api/loads/{id}/assign` — driver assignment checked against that carrier
- `POST /api/loads/{id}/milestones` — validated milestone transitions, optimistic versioning, actor attribution
- `POST /api/loads/{id}/check-ins` — manual or provider-sourced observation with provenance
- `POST /api/loads/{id}/exceptions` and `/exceptions/{id}/resolve`
- `POST /api/loads/{id}/documents/presign` and `POST /api/documents/{id}/finalize`
- `POST /api/loads/{id}/billing-packets` and `POST /api/dispatch-invoices`

Use structured validation errors, stable codes, authorization checks on every call, event emission within the database transaction/outbox, idempotency for imports and external callbacks, and conflict responses when a load changes concurrently.

### Critical invariants

1. Every booked load is linked to **one pre-authorized motor carrier**; dispatch cannot independently reallocate freight among carriers.
2. Drivers/vehicles must belong to or be authorized by the load's carrier. Carrier users cannot access another carrier's records.
3. Operational shipment status, document completeness, carrier invoice/payment status and the dispatch company's own invoicing are separate state machines.
4. Tracking must distinguish driver-reported, ELD-derived, third-party and estimated information; freshness is visible. No falsely implied real-time locations.
5. Delivered loads can still have exceptions and missing PODs. Exceptions never silently disappear upon milestone updates.
6. Original documents are immutable or versioned with a complete provenance trail.
7. Broker freight proceeds belong to the carrier's financial workflow; the dispatcher invoices carriers under the dispatch agreement.

### Failure, recovery, and support

Support empty/loading/unavailable/stale/partial/permission-denied/error states. For document imports, account for corrupt PDFs, scan failure, duplicate submissions, file-size limits, malware, storage outages, retries and manual review. For webhooks and messaging, implement signature checks, bounded retries, dead-letter queues, idempotency and delivery audit. Reconcile late provider events without overwriting newer authoritative milestone records. Support operator audit views without exposing private driver information to unrelated tenants.

### Security, privacy, compliance

Authenticated sessions and least-privilege server RBAC; object-level carrier scoping; upload scanning; signed short-lived document URLs; scoped service tokens; CSRF/XSS/SSRF protection, rate limits, input validation, secret rotation, audit trails and retention/deletion policies. Obtain and document driver tracking/messaging consent where required. Have carrier-agent dispatch workflows and contracts reviewed for FMCSA brokerage implications before live operation.

### Delivery sequence

1. **Foundation:** auth, carrier authorizations, schema + migrations, seeded QA fixtures, typed API contracts, first work queue and load details.
2. **Operational MVP:** assignments, milestones, manual check-ins, exception queue, document uploads, durable events and audit UI.
3. **Financial handoff:** carrier billing packet and separate dispatch invoices, reconciliation and exports.
4. **Carrier/driver portals:** server-scoped permissions, secure assigned-load mobile experience, notifications with consent and delivery confirmation.
5. **Integrations:** load imports, telematics, accounting, SMS/email and webhook delivery. Add reconciliation and operational monitoring before scaling.
6. **Automation and AI:** document extraction with human review, SLA reminders, ETA-risk alerts and carefully measured time saved per load.

For each release: schema migration → backfill → compatibility deployment → tests (unit, integration, permission isolation, end-to-end, accessibility) → metrics/alerts → staged rollout → rollback plan → cleanup. Require lint, typecheck, tests and build gates in CI. Measure dispatcher minutes per load, missed check-ins, late appointments, POD collection time, billing packet time and exception resolution.

## Handoff

`freight-dispatch-tms-demo.html` is a standalone local prototype. Open in a modern browser. Nothing is deployed. Browser data is stored locally and may be cleared by reset/browser storage cleanup. The prototype is not an authenticated, secure, or multi-user production service.
