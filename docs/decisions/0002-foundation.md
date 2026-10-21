# ADR 0002 — Carrier-scoped transactional foundation

Status: implemented for local QA, pending production review.

Next.js serves the UI and Node server contracts as one modular application. PostgreSQL owns loads, ordered stops, memberships, sessions, assignments, domain events, audit and outbox. No live side effects are enabled. The original demo remains at /demo.html with independent local browser state.

Membership rows grant dispatcher/carrier-manager writes to explicit carriers; drivers can only read assigned loads. The server never trusts client carrier or role claims. Compound foreign keys prevent cross-carrier driver and vehicle assignments. Load writes use row locks and expected versions. Idempotent creation serializes identical user keys and verifies request hashes. Load events, audit and outbox are committed in the same transaction.

Money is stored in integer cents (bigint with JS-safe bound). Shipment milestones are the only implemented status machine; no financial or document status is inferred from delivery. Agreements must be verified and effective before booking.

Migration 001 is additive from an empty database and is recorded transactionally. Repeat migration runs are no-ops. Back up before release; roll back the application first, preserve schema and data. No destructive down migration is provided: for disposable QA only, recreate the entire database. Future changes must follow expand/backfill/verify/contract. Database owners must be separate from restricted runtime users before production; append-only triggers alone are not a privileged-admin security boundary.

No outbox consumer, document storage, shared rate limiter, identity provider, public signup, paid service, deployment or live carrier connection is configured. These need separate operational decisions and review.
