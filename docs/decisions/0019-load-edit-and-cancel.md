# 0019 — Load edit and cancel

Status: accepted, 2026-10-21.

## Decision

Booked freight can now be corrected and cancelled without breaking the single source of truth. `loads` and `load_stops` stay authoritative; every change is also written to the append-only `load_changes` table (one row per field: old value, new value, actor, reason, group id) and a `load.edited` / `load.cancelled` event.

**Editable:** reference, booking source, agreed rate, and each stop's address, time zone and appointment window. Stop count, order and kind are fixed; a different route is a different load.

| Stage                 | Edits                | Reason       |
| --------------------- | -------------------- | ------------ |
| booked                | all of the above     | optional     |
| dispatched, picked-up | all of the above     | **required** |
| delivered             | none (`LOAD_LOCKED`) | —            |

A stop that already has an arrival or departure recorded is locked (`STOP_ALREADY_STARTED`) so measured timing cannot be rewritten by moving the appointment. Windows must keep the stops in time order. References stay unique per carrier (`REFERENCE_TAKEN`). Edits use the load's optimistic `version`.

**Cancel:** allowed only while `booked` or `dispatched`; a load already picked up cannot be cancelled (record an exception instead). A reason is required. Cancellation sets `cancelled_at/by/reason` (all-or-nothing by constraint) and leaves `stage` as history. The load then rejects every write (`LOAD_CANCELLED`), disappears from active queues, appears under a Cancelled queue, and its open exceptions are resolved with "Load cancelled: …". Cancelling is final; the replacement is a new load, so freight is never implicitly moved between carriers.

**Driver notice:** the assigned driver gets a queued notification (kind `assignment`, deduplicated per load version) when a stop address or time changes or the load is cancelled. Rate and reference-only edits do not notify.

**Authorization:** dispatchers and carrier managers of the load's carrier only; drivers and other tenants get `NOT_FOUND`. Billing/payment statuses are untouched: a delivered load (the only kind billed) cannot be edited.

## Rollback

Migration 017 is additive. Code that ignores the columns behaves as before; leave the table in place.
