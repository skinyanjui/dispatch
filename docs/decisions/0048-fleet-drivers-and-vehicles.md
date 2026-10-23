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

> **Superseded in part by ADR 0052.** Lists described above as cards on phones, or with labelled facts in each row, are now `DataTable`s: column names appear once in the header, narrow screens scroll sideways with the row name held in place, low-priority columns drop out under 640px, and sorting is on the column headers (no separate sort select). See `docs/design-system.md`.

## Demo

The interactive demo runs the Fleet page on browser-only fictional data (`src/lib/demo-fleet.ts`), with the same rules as `src/lib/fleet.ts`: unit names are unique per carrier, edits are versioned, retired vehicles cannot be chosen for new assignments, and drivers and other carriers get a 404. Choosing a vehicle when assigning a driver works in the demo too. Nothing is saved outside the browser. Before this, the demo had no `fleet` route, so the page showed "We couldn't find that" with a Retry button.
