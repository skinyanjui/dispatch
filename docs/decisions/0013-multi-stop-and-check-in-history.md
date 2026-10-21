# 0013 — Multi-stop loads, check-in amendments and history paging

Status: accepted, 2026-10-21.

## Multi-stop loads

A load has 2–10 ordered stops (`load_stops.sequence`). The first stop is a pickup and the last a delivery; stops in between may be either. Each appointment window must start no earlier than the previous one ends. The schema already modelled ordered stops, so no migration was needed. Queues show the first pickup, the final delivery and the stop count.

Shipment milestones stay **load-level** (booked → dispatched → picked up → delivered), meaning the first pickup and the final delivery:

- missed-appointment suggestions compare against those two stops;
- assignment emails name them;
- an intermediate stop's window passing is not treated as a missed final delivery.

Per-stop arrival/departure tracking would be a separate stop-event model and is not built.

## Check-in corrections and retractions

Check-ins stay immutable. A **correction** (new location, observed time and note) or a **retraction** is an append-only `check_in_amendments` row, and each requires a reason.

- The effective report is the original overlaid by its latest correction. The UI shows the original value and every amendment with its author, time and reason.
- Retraction is final, enforced by a unique index. Retracted reports remain visible (struck through) and never become the headline location.
- Amendments use the same optimistic load version, actor-scoped idempotency key and time-window rules as check-ins. Each appends `load.check-in-correct|retract` events with outbox and audit rows.
- Dispatchers and carrier managers may amend any report for their carrier. A driver may amend only their own reports, and only on loads still assigned to them.

## Older history

Load detail returns the newest 100 events and 50 effective check-ins, plus opaque cursors. `GET /api/loads/:id/events?before=` and `GET /api/loads/:id/check-ins?before=` return older pages.

- Cursors carry PostgreSQL text timestamps (microsecond precision) and ids, validated strictly before use.
- Ordering is `(created_at, id)` for events and `(effective observed_at, recorded_at, id)` for check-ins, so pages never repeat or skip records.
- The UI merges older activity by id, so a refresh that shifts the newest window cannot duplicate entries.

## Rollback

Keep migration 011 (additive). Older application code ignores amendments and shows only the original reports. Loads with more than two stops show their first two stops in older list views.
