# 0008 — Exception management

Status: accepted, 2026-10-21.

## Decision

An exception (`load_exceptions`) is a per-load aggregate with its own optimistic `version`. It has a type (delay, missed appointment, missing document, other), severity, an optional owner and due time, and an open → in progress → resolved lifecycle with reopen. Exceptions do **not** bump the load's version and are never changed by milestone updates. A delivered load can still carry open exceptions.

- **History.** Each change appends a `load_events` row (`exception.opened|assigned|started|resolved|reopened`) with outbox and audit, so the load timeline is the single history. The exception row holds current state only.
- **Who can do what.** Dispatchers and carrier managers open, assign, start, resolve and reopen exceptions for their carriers. Drivers may open exceptions only on loads currently assigned to them (re-checked under the load lock), cannot set an owner or deadline, and cannot change exceptions. Owners must be a dispatcher or carrier manager of that same carrier. Foreign or guessed IDs return 404.
- **Resolution and reopening** each require a reason. Creation is idempotent per actor key.
- **Suggestions, not automation.** `suggestExceptions()` (shared by server, UI and demo) proposes checks from *recorded* data only:
  - a pickup or delivery window ended without the matching milestone;
  - a required document is missing or rejected (rate confirmation once dispatched, BOL once picked up, POD once delivered).

  A suggestion is suppressed while an active exception of the same type/document exists. Nothing is created automatically, which avoids duplicate or misleading exceptions from late milestone entry. This is not live tracking.
- **Queue.** `GET /api/exceptions` returns active exceptions first, ordered by severity, then due time, then age, filterable by status, owner (me/unassigned) and overdue. It is capped at 100 rows with a truncation flag.

## Rollback

Revert the application while keeping migration 006 (additive). Exceptions and their events remain.
