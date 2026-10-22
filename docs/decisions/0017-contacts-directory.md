# 0017 — Contacts directory and quick connect

Status: accepted, 2026-10-21.

## Decision

One searchable **Contacts** page replaces hunting through carrier, driver and load screens. It is a _read view_ over records that already exist, plus one new table for people outside the system:

- **Team** — dispatchers and carrier managers (`memberships` + `users`, with the account phone from ADR 0016).
- **Drivers** — `drivers` (name, phone, email or the joined account's email).
- **Carriers** — the company contact from `carrier_profiles`.
- **External contacts** (`contacts`) — brokers, shippers, receivers, facilities, vendors and others. They belong to an organization and may be linked to one carrier.

Nothing is copied, so a changed phone number or removed driver is reflected immediately and there is still one authoritative record for each person.

**Access follows the caller's own memberships** (enforced in the query, not the UI):

- _Dispatchers_ see team, drivers and company contacts of their carriers, and every external contact in their organization.
- _Carrier managers_ see their carrier's dispatchers, managers and drivers, and external contacts linked to that carrier.
- _Drivers_ see only the dispatchers and managers of their carrier, so they can always reach dispatch. They see no other drivers and no external contacts.
- Organization administrators also see their organization's external contacts. Nobody sees themselves. A foreign carrier's people never appear.
- Dispatchers and administrators add or edit external contacts anywhere in their organization; carrier managers only contacts linked to their own carrier, and cannot move one to another carrier; drivers cannot add any. Contacts are archived, never hard deleted, and writes use optimistic versions, an idempotency key and audit records.

**Search** matches name, company, email and phone. Phone numbers match by digits, however they were typed (`214-555`, `(214) 555-0199`). `%` and `_` are escaped so they search literally. Each group is capped at 25 rows when unfiltered, with a "Show all N" link per group, so a large roster can never hide an entire category (a real bug found while testing); choosing a group lifts the cap to 100.

**Favorites** are per user, can only be set on entries the user can see, and sort first.

**Quick connect** uses the user's own device: `tel:`, `sms:` and `mailto:` links, plus copy. These send nothing from Relay. The in-app **Message** action (ADR 0018) is the logged, consent-aware path.

## Not included

CSV import/export, duplicate detection and merging, per-contact history, groups and tags, and contact photos.

## Rollback

Keep migration 015 (additive).

## Directory rows

Presentation only; no API, schema or permission change. Each person is a row in one bordered list: an initials avatar tinted by group (team, driver, carrier, other), the name, the role and first carrier with "+N more" when a person is linked to several (the full list is in the tooltip), the phone and email, then one row of actions (call, text, email, copy, favorite, Message, Edit). On phones the icon actions share one row and Message and Edit share the next at full width. Accessible names are unchanged. The old two-column card grid and its CSS were left in place but are no longer used by this page.
