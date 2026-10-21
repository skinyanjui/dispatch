# Codex repository instructions

## Product objective
Develop Relay, a production-ready carrier-agent freight dispatch management system for a U.S.-based, non-asset dispatch company. The existing `index.html` is a functioning **demo reference**. Preserve its useful workflows while moving toward a typed full-stack application.

## Working method
- Do not deploy, provision paid services, connect live carriers, send messages, or incur costs unless explicitly requested.
- Prefer a modular monolith, Next.js and TypeScript for the app, PostgreSQL for transactional data, object storage for secure document uploads, and durable jobs/outbox for events.
- Keep exactly one authoritative source of truth per load, stop, exception, document, assignment and invoice.
- For every feature, trace end-to-end: user intent → UX → server contract → authorization → domain logic → database → event/integration → observability and recovery.
- Introduce migrations using expand → backfill → dual-read/write compatibility as required → verify → contract; rollback must be documented.
- Do not claim mocked data is live or that tracking observations are real-time without source and timestamp.
- Use integer minor units or fixed-precision decimal for money; no JS floating point for billing calculations.
- Prevent cross-carrier access in server handlers, queries, file retrievals, exports, jobs and webhooks. Test permission isolation, including guesses of foreign IDs.
- Maintain independent load milestones, document readiness, carrier billing/payment, and dispatcher invoice/payment status.
- Require a carrier with verified written dispatch authorization before any booked load can be created or assigned; never implicitly transfer booked freight across carriers.
- External side effects require clear consent, idempotency, retries with bounded backoff, failure visibility, and an audit record.
- Support keyboard use, accessible labels, screen-reader status messages, mobile layout and clear empty/loading/error/retry states.
- Keep original uploaded documents immutable or versioned, with provenance and access/retention controls.
- Treat AI as a human-reviewed assistant for probabilistic tasks, not an authority for booking, rate confirmations, invoicing or funds movement.
- Each change must include code, DB migration (where applicable), tests, docs and operational updates, in atomic commits.

## Immediate task
Read `docs/codex-tasks.md` and `docs/build-plan.md`. First deliver Phase 1 foundation as a reviewable PR: database schema, tested carrier RBAC, authenticated sessions, load creation/list/detail APIs and a production UI derived from the demo. Leave demo accessible as a separate route or static reference during migration.

## CI gate
Lint, typecheck, tests, build, plus integration/migration/authorization and browser tests when added. If an area cannot be tested yet, state the gap explicitly rather than claiming production-readiness.

## Decision documentation
Record changes to tenancy, dispatch/broker boundary, data ownership, event handling or deployment in lightweight ADRs under `docs/decisions/`.
