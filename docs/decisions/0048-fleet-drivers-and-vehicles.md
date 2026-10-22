# 0048 Fleet: drivers and vehicles

Status: accepted

## Decision

A **Fleet** page (`/fleet`, in the sidebar for dispatchers and carrier managers; drivers do not see it) lists one carrier's drivers and vehicles side by side.

- **Drivers** stay owned by carrier setup (a driver is a person with a login, invited and removed there). The page reads them (name, active or invite pending, phone, email, count of active loads) and links to setup; it does not create a second way to add or remove drivers.
- **Vehicles** become real records. `vehicles` has existed since migration 001 with only `id`, `carrier_id` and `label`, and nothing wrote to it. Migration 037 (expand only) adds `kind` (tractor, straight truck, box truck, cargo van, Sprinter van, trailer, other), `plate`, `vin` (17 characters, no I, O or Q, checked in the database as well), `status` (`active` or `retired`), `version`, timestamps, a label length check and a unique index on (carrier, lower(label)). The migration fails loudly if existing rows would violate the new checks. Rollback: drop the index and added columns.
- **API:** `GET /api/fleet?carrier_id=`; `POST /api/fleet/vehicles`; `POST /api/fleet/vehicles/:id` (optimistic `version`); `POST /api/fleet/vehicles/:id/status`. Every write carries an idempotency key (the onboarding request table), so a retried save after a lost response is one vehicle; a duplicate name is `409 DUPLICATE_VEHICLE`, a stale edit `409 VERSION_CONFLICT`. Every change goes through the existing `emit` helper (onboarding event, outbox, audit row).
- **Authorization:** dispatchers and carrier managers of that carrier only. A driver, another carrier's manager and a guessed id all get the same `404 NOT_FOUND`.
- **Assignment:** the assign endpoint accepts an optional `vehicleId`. It must belong to the load's carrier and be in service (`422 VEHICLE_CARRIER_MISMATCH` otherwise); omitting it keeps the current vehicle, `null` clears it. A vehicle retired later stays on loads it is already on but cannot be picked again. The load's assignment form shows a vehicle choice when the carrier has vehicles, and the record shows "Driver · Unit".

## Consequences

Vehicles are never deleted, only retired, so past loads keep their equipment. Not done: assigning a vehicle to a driver as their usual one, vehicle documents (registration, inspection), equipment type constraints on loads, and a separate way to add drivers from this page.

Found while building: absolutely positioned screen-reader text inside a scrolling table widened the whole page on phones; scrolling tables are now positioned so it is clipped with them.

## Page redesign

The page was rebuilt without changing the API, schema or permissions: a toolbar (carrier, Add vehicle), four summary tiles that share one row (vehicles in service, on active loads, drivers active, invites pending), a vehicles panel and a drivers panel, each with a count. Vehicles come first because they are what the page edits. The per-row "Manage" buttons became one "Invite or remove drivers" button, since drivers are still managed in carrier setup. On phones each table row becomes a card with its labels. Accessible names (tables "Vehicles" and "Drivers", the "Show retired" checkbox, row buttons) are unchanged.
