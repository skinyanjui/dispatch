# 0064 Change control for payout details, carrier contacts and reroutes

Status: accepted, 2026-10-24.

## Context

Market research (`Relay dispatch TMS market`, 2026-10-24) found the harms that matter most to carriers and dispatchers are impersonation and redirection: spoofed calls and lookalike domains that change who gets paid, who is called, or where a load goes. Relay already isolates carriers and audits writes, but one person could change a carrier contact's phone, a stop address after dispatch, or (once stored) remit-to details without anyone else seeing it.

## Decision

- **Sensitive changes** (`sensitive_changes`, migration 042) are requested by one person and applied only when a different person approves. Kinds: `payout_details`, `contact_details` (phone or email of a contact linked to a carrier), `reroute` (a stop address change on a load that has left `booked`).
- **Who approves:** a carrier manager of that carrier, or an owner/admin of the carrier's organization; never the requester. The database enforces it with a CHECK, not only the handler. Anyone else, including drivers and other carriers' people, gets 404.
- **Verification:** an approval must record how it was confirmed outside the request: `callback` (to a number already on record), `document`, or `in_person`. Without one the approval is refused.
- **Cooling-off:** approved payout details take effect `RELAY_PAYOUT_COOLING_HOURS` later (default 24, 0 to 168). They are visible as "cooling off" until then, and any export that uses them must wait (ADR 0069).
- **Stale requests:** if the contact or stop changed after the request, approval marks it `stale` and applies nothing; the person asks again.
- **No account numbers:** payout details are payee, method and last four digits. Relay never holds freight proceeds, so it stores the minimum a human needs to confirm the account.
- **Guarded paths:** `updateContact` parks a phone or email change on a carrier-linked contact (other fields apply immediately; a reason is required); `editLoad` parks an address change on a dispatched or later load (the whole edit waits; drivers are notified only when it is applied, as the requester). Contacts with no carrier and edits while a load is booked are unchanged.
- **Audit:** `change.requested`, `.approved`, `.rejected`, `.cancelled` and `.stale` are in the audit log with the change id; the row keeps requester, decider, time, verification and note.

## Consequences

A single-person organization cannot approve its own changes and needs a carrier manager or a second admin; that is the intent. Money is not involved here. Rollback: leave the tables; code that ignores them applies the guarded edits directly (revert `contacts.ts` and `load-changes.ts` hooks).
