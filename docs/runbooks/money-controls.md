# Money controls runbook

What each control does, how to operate it, and how to back it out. Decisions: ADRs 0064 to 0069. None of these send anything to a carrier, broker, factor or registry unless stated.

## Change control (ADR 0064)

- **What it guards:** a carrier's payout details, a carrier-linked contact's phone or email, and a stop address after a load has left `booked`.
- **Who approves:** a carrier manager of that carrier or an owner or admin of its organization, never the person who asked. A one-person organization needs a carrier manager or a second admin; that is by design.
- **Settings:** `RELAY_PAYOUT_COOLING_HOURS` (0 to 168, default 24): how long approved payout details wait before they count.
- **Support questions:** "Why can't I approve my own request?" The database refuses it. "Why does a request say out of date?" The record changed after it was asked; ask again. Pending requests are visible in the carrier's files under Payout details and approvals.
- **Back out:** revert the guarded paths in `contacts.ts` and `load-changes.ts`; the tables can stay.

- **Hardening (ADR 0070):** unlinking or moving a carrier contact, and changes to a finished carrier's name, contact email, phone or USDOT number, wait for approval too. Approving needs the approver's password (and a two-step code if enrolled); six wrong tries in five minutes lock approvals for that person for five minutes. People who sign in only through a provider must set a password first.

## Registration lookups (ADR 0065)

- **Settings:** `RELAY_AUTHORITY_PROVIDER` = `fmcsa` (needs `FMCSA_WEBKEY`) or `fixture` (fictional, for demos only). In production with neither, "Check now" answers 503 and the daily job skips, on purpose.
- **Cadence:** the daily job re-checks carriers with finished setup and a USDOT number, 50 per run, retrying failures after an hour up to four times. Findings raise the `authority.attention` operations alert.
- **Caveat:** the FMCSA parser has not been run against the live service from this repository. Run one lookup by hand and compare with the public site before relying on it.
- **Back out:** unset the provider; remove the `authority` step from `jobs.ts`.

## Cash view and paperwork owners (ADRs 0066, 0068)

Read-only. Billing, Cash shows net per load and days to cash (a fee is real only when the load is on a dispatch invoice; a typed percentage is an estimate) and which loads are held up by paperwork and by whom. Back out by removing the tabs; nothing is stored.

## Detention and TONU (ADR 0067)

TONU needs the payer's cancellation (recorded when a dispatched load is cancelled) and terms that are in writing (ADR 0070).

Terms that cite the rate confirmation store a link to the load's accepted rate confirmation file (refused without one; ADR 0071), and the packet names it. Billing, Claims tab: every claim for the carrier, with totals and sent claims waiting 14+ days.

Per load, Claims tab: terms, then claims that freeze their evidence. Terms are locked while a claim is open. Times are people's reports, not telematics; the packet says so. Rollback: remove the tab and routes; the tables can stay.

## Factoring handoff (ADR 0069)

Cancelling a schedule already handed to the factor holds its loads until the carrier releases them, confirming the factor has not advanced on them (ADR 0070).

Only a carrier manager turns it on, with consent. Schedules are CSVs the carrier hands over; Relay sends nothing and cannot see funding. A schedule can be cancelled (even after handoff), releasing its loads. If a factor needs a different layout, add a mapping on top of the stored batch rather than changing the stored file.

## Registration alerts and retention (ADR 0072)

A carrier that turns to attention notifies its dispatchers and managers once (kind `registration_alert`, mutable in notification settings) and shows on the carrier list. The freight packet shows the payout details in force. Claim evidence, factoring CSVs and lookup history are kept while the carrier exists; no deletion job exists. Rollback: leave migration 048; remove the column and the alert.

## Not built

Live factor integrations, paid carrier-verification vendors, geofence or ELD evidence for detention, and demo versions of these screens (the public demo hides them rather than faking them).
