# Codex implementation backlog

## Task 1 — Production foundation (start here)

Implement an authenticated, carrier-scoped application, incrementally replacing the static prototype while preserving its load queue and inspector UX.

**Delivery**

- Create a Next.js + TypeScript modular-monolith app under `apps/web` (or `src` if a single app is simpler).
- PostgreSQL schema/migrations for organizations, members, roles, carrier authorization, driver, vehicle, load, ordered stops, assignment, event/outbox and audit.
- Sample seed data is fictional only; the demo remains separate.
- Typed and validated server contracts: create booked load, list/search/filter, load detail, assign driver, record milestones; authorization is server-side for every operation.
- Atomic load transition with durable append-only event and outbox, version/concurrency protection and idempotent create.
- Role-based dispatcher/carrier-manager/driver access with explicit carrier/driver boundaries and tests preventing cross-carrier data reads and writes.
- Work queue and load details from the prototype migrated to real data, with loading, empty, error, offline/stale states and accessible mobile UI.
- README/ADR, local setup/environment example (without secrets), CI checks, test DB instructions.

**Definition of done**

- `lint`, `typecheck`, tests and build pass; database migrates from empty state; local seeded environment runs.
- Integration tests cover authority validation, unique references/duplicate requests, stop order/timezone, concurrent updates, event outbox and tenant isolation.
- No production data, outbound SMS/email, external freight booking, or live telematics used.

## Task 2 — Operational workflow

Manual check-ins with provenance, exception lifecycle, assigned dispatcher queues, stops and timeline. Add audit and retry/error handling.

## Task 3 — Secure documents

Object storage, versioning, malware checks, BOL/POD workflows, signed links, file retention policy, upload recovery, access tests.

## Task 4 — Carrier/driver portals

Carrier-authorized load visibility; mobile assigned-load experience; on-device photo upload; consent and notification preferences.

## Task 5 — Financial handoff

Carrier packet status, accounts-receivable visibility for carrier (without custody of carrier proceeds), independent dispatch fee invoices, fixed-precision totals and reconciliation.

## Task 6 — Integrations and operations

Telematics adapters, manual fallback, rate-confirmation import, emails/SMS with consent, webhook validation, idempotent jobs, dead-letter and reconciliation dashboards, metrics/traces/alerts.

## Task 7 — AI assistance

OCR/document extraction and suggested customer updates with human confirmation, eval fixtures, cost limits and provenance. Never autonomously accept/reallocate freight.

## First Codex prompt

```
Read AGENTS.md, docs/build-plan.md, docs/product-requirements.md, and
docs/codex-tasks.md. Implement Task 1 as a coherent production foundation.
Keep the current browser demo working, create a new typed application,
and follow schema→migration→authorization→API→UI→tests→CI→docs.
Do not deploy, connect live third-party services, or send external messages.
Give me a PR-style summary, test evidence, residual risks, and next steps.
```
