# 0026 — Idempotent load changes and what cancellation touches

Status: accepted, 2026-10-21. Extends [0019](0019-load-edit-and-cancel.md).

## Decision

**Editable fields by stage** (unchanged from 0019, restated as the contract):

| Field | booked | dispatched / picked-up | delivered / cancelled |
|---|---|---|---|
| Reference, booking source | edit, reason optional | edit, **reason required** | locked |
| Agreed rate (integer minor units) | edit, reason optional | edit, **reason required** | locked |
| Stop address, time zone, appointment window | edit, reason optional | edit, **reason required**, only for stops with no arrival/departure | locked |
| Carrier, stop count/order/kind | never | never | never |

**Idempotency.** `POST /api/loads/:id/edit` and `/cancel` accept an optional `Idempotency-Key` (1–128 chars; a blank header is `400 IDEMPOTENCY_KEY_REQUIRED`). The UI always sends one. Results are stored in the append-only `load_change_requests` table (migration 023) keyed by actor and key with a hash of the body. A retry with the same key and body returns the stored result, including after the load was cancelled by that very request; the same key with another body, load or action is `409 IDEMPOTENCY_CONFLICT`. Authorization runs first, so a foreign load ID is `404 NOT_FOUND` whatever key is sent and a stored result is never replayed to another tenant. The UI reuses a key only while the form content is unchanged. Without a key behaviour is as in 0019: a stale retry is `409 VERSION_CONFLICT`. Every applied change still writes `load_changes`, a `load.edited`/`load.cancelled` event, the outbox and an audit log row once; replays write nothing.

**What cancellation does to related records** (the load is final once cancelled; `stage` stays as history):

- **Assignment:** the `load_assignments` row is kept as history and the driver is notified (deduplicated per load version). A cancelled load no longer counts as an active load, so it does not block removing the driver from the team (bug fixed here). The load cannot be reassigned or advanced (`LOAD_CANCELLED`).
- **Exceptions:** open exceptions are resolved with "Load cancelled: …"; none can be opened afterwards.
- **Documents:** existing documents and versions stay, immutable, with their provenance. Uploads, reviews and other writes are rejected on a cancelled load.
- **Billing:** only a delivered load can have a carrier billing packet or dispatcher invoice line, and a delivered load cannot be cancelled, so cancellation never alters packet, carrier payment or dispatcher invoice/payment status. Cancelled loads are hidden from the billing queue (they have nothing to bill) and excluded from reports' freight totals.
- **Freight is never moved:** the replacement for cancelled freight is a new load with its own carrier authorization check.

## Rollback

Migration 023 is additive (one table). Code that ignores it behaves as in 0019; leave the table in place. Reverting the billing-queue and driver-removal filters restores the previous behaviour.
