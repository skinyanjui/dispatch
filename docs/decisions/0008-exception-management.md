# 0008 — Exception management

Status: accepted, 2026-10-21.

## Decision

An exception (`load_exceptions`) is a per-load aggregate with its own optimistic `version`. It has a type (delay, missed appointment, missing document, other), severity, an optional owner and due time, and an open → in progress → resolved lifecycle with reopen. Exceptions do **not** bump the load's version and are never changed by milestone updates. A delivered load can still carry open exceptions.

- **History.** Each change appends a `load_events` row (`exception.opened|assigned|started|resolved|reopened`) with outbox and audit, so the load timeline is the single history. The exception row holds current state only.
- **Who can do what.** Dispatchers and carrier managers open, assign, start, resolve and reopen exceptions for their carriers. Drivers may open exceptions only on loads currently assigned to them (re-checked under the load lock), cannot set an owner or deadline, and cannot change exceptions. Owners must be a dispatcher or carrier manager of that same carrier. Foreign or guessed IDs return 404.
- **Resolution and reopening** each require a reason. Creation is idempotent per actor key.
- **Suggestions, not automation.** `suggestExceptions()` (shared by server, UI and demo) proposes checks from _recorded_ data only:
  - a pickup or delivery window ended without the matching milestone;
  - a required document is missing or rejected (rate confirmation once dispatched, BOL once picked up, POD once delivered).

  A suggestion is suppressed while an active exception of the same type/document exists. Nothing is created automatically, which avoids duplicate or misleading exceptions from late milestone entry. This is not live tracking.

- **Queue.** `GET /api/exceptions` returns active exceptions first, ordered by severity, then due time, then age, filterable by status, owner (me/unassigned) and overdue. It is capped at 100 rows with a truncation flag.

## Rollback

Revert the application while keeping migration 006 (additive). Exceptions and their events remain.

## Queue page redesign

The Exceptions page was restyled without changing the API, schema or permissions. A filter row (status, owner, overdue only) sits above four summary tiles that share one row (shown, high severity, overdue, unassigned, counted from the loaded list, which is capped at 100). Each exception is a card with a severity stripe, its pills, a wrapping row of labelled facts (load, carrier, type, owner, due, overdue in red) and the Open load button; on phones the facts become two columns and the button fills the card. Loading shows a placeholder, and accessible names are unchanged.

> **Superseded in part by ADR 0052.** Lists described above as cards on phones, or with labelled facts in each row, are now `DataTable`s: column names appear once in the header, narrow screens scroll sideways with the row name held in place, low-priority columns drop out under 640px, and sorting is on the column headers (no separate sort select). See `docs/design-system.md`.
