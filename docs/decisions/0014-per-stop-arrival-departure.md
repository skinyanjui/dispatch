# 0014 — Per-stop arrival and departure tracking

Status: accepted, 2026-10-21. Extends ADR 0013.

## Decision

Each stop can carry a manually reported **arrival** and **departure** time (`stop_events`). Reporting follows the same provenance rules as check-ins:

- the server records the actor and receipt time;
- `source` is always `manual`;
- times are stored as instants, entered and shown in the stop's own time zone;
- times must fall within the last 30 days and no more than 5 minutes ahead.

- **Who:** dispatchers and carrier managers for their carriers; drivers only on loads currently assigned to them. Foreign loads, foreign stops and guessed IDs return 404.
- **Ordering:** times may never run backwards along the route.
  - A departure needs an arrival at the same stop and cannot precede it.
  - An arrival cannot precede the previous stop's departure (or its arrival, if no departure is recorded).
  - Neither can follow the next stop's recorded arrival.
  - Out-of-sequence entry is allowed, for example recording stop 3 before stop 2 is caught up.
  - The rules live in `src/lib/stop-timing.ts`, shared by the server and the demo.
- **Corrections:** rows are immutable. A second report of the same kind must name the current report (`supersedes`) and give a reason, otherwise the server answers `409 STOP_EVENT_EXISTS` or `STOP_EVENT_CHANGED`.
  - Unique indexes keep each chain linear: one first report per stop and kind, and one successor per report. Concurrent reporters therefore cannot silently overwrite each other.
  - The current value is the report no later report supersedes. The full history stays visible.
  - Each report bumps the load version (optimistic concurrency), is idempotent per actor key, and appends `load.stop-arrived|departed[-corrected]` events with outbox and audit rows.
- **Milestones are unchanged.** Stop reports never advance the load stage; the explicit load-level milestone action stays the authority (consistent with check-ins and ADR 0008). Stop reports do inform the exception suggestions:
  - an arrival after the window closes suggests a delay;
  - an intermediate stop whose window passed with no recorded arrival suggests a missed appointment;
  - a recorded departure from the first pickup, or arrival at the final delivery, suppresses the load-level missed-appointment suggestion.
- **Display:** lateness against the window end, dwell time between arrival and departure, and a "check detention" flag at 2 hours or more. That threshold is a display convention, not a contractual detention rule.

## Not included

Geofenced or ELD-sourced automatic arrivals, detention billing, appointment rescheduling and per-stop document requirements.

## Rollback

Keep migration 012 (additive). Older application code ignores stop events.
