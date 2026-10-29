# 0072 Registration visibility, payout on packets, retention

Status: accepted, 2026-10-29. Follows audit items 17 to 21 in `docs/audits/2026-10-29-money-controls-audit.md`. Amends ADRs 0065, 0067, 0069 and 0070. Migration 048 is expand-only.

## Decision

1. **Registration state is visible where carriers are listed (0065).** The carrier list has a "Public registration" column (clear, needs attention, unverified, not checked) taken from the latest lookup for the number now on file, with the same rules as the carrier's files dialog. It opens the files.
2. **Dispatchers are told when a carrier turns to attention (0065).** When a lookup moves a carrier to `attention` from a state that was not attention (or from none), the people who dispatch or manage that carrier and its organization's members each get one `registration_alert` notification naming the findings (migration 048; muting the kind is theirs to choose). The state compared is the previous lookup whatever its number, so a changed USDOT number that then looks bad still raises one. A failed lookup alone raises none: that is the operations alert's business. Nothing is blocked automatically.
3. **The packet says where to pay (0070).** Billing's freight packet shows the payout details in force ("Pay the carrier at"), or says there are none, or that they are not in force until the cooling-off ends. Submitting a packet records those details (`remit_to`) in the load's event, so the cooling-off protects what payers are told. The invoices Relay sends to carriers are unchanged: they ask for Relay's fee, not the carrier's freight money.
4. **Retention (0067, 0069), decided but not automated.** Claim evidence, factoring schedules and CSVs, and registration lookups are kept while the carrier exists; they are append-only or frozen on purpose, and no job deletes them. Relay stores no bank account numbers (last four only). Deleting a carrier's records on request is a manual, audited operation that has not been built; until it is, say so rather than promise erasure. Revisit when a retention period is chosen with counsel; the code to add is a bounded delete job per table and an audit row.
5. **Verification is self-attested and says so (0064).** "I called a number already on record" cannot be proved by software. The record keeps who said it, when, and the optional note; the approver also proves who they are with their password again (0070). This is the limit of what Relay can claim and the screens do not call it "verified".
6. **Interaction coverage.** Browser tests cover the Claims, payout and factoring screens at 390px (no horizontal scroll, axe), tab keys between Billing tabs, opening the approval form by keyboard, focus moving into the form, and focus returning to the section after a decision (the Review button it came from is gone).

## Consequences

The carrier list reads one more lookup history per row (bounded by the people's own carriers). More notifications go out when registrations change; each is deduplicated per lookup and person. Items 19 and 20 are documented limits, not fixes. Rollback: leave migration 048's wider checks; remove the column, the alert and the packet line.
