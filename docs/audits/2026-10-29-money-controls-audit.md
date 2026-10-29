# Money controls audit, 2026-10-29

Scope: ADRs 0064 to 0069 as shipped (change control, registration lookups, cash view, detention and TONU, paperwork owners, factoring handoff), their API, screens and tests. Method: code reading plus throwaway probe tests against the real modules. **Verified** means a probe or grep reproduced it; **by reading** means the code shows it but nothing was run. No fixes are included; this is the list.

## High: a control can be bypassed or a result is wrong

1. **Change control is bypassed by unlinking a contact (verified).** Only an edit that keeps the contact on the same carrier is held. Unlinking (`carrier_id: null`) applies immediately, and the next edit, now with no carrier, changes phone and email with no approval. Moving the contact to another carrier with new details in the same call also applied. Fix: hold any phone or email change on a contact that is or was carrier-linked, and treat unlinking or re-linking as a guarded change.
2. **The carrier's own contact details are not guarded at all (by reading).** `saveCompany` (carrier setup) rewrites the carrier's contact name, email, phone, name and USDOT number directly. Invitations and sign-in emails go to that address, so it is the better impostor target than a contact.
3. **A new USDOT number inherits the old carrier's "clear" (verified).** Status is derived from the carrier's latest lookup without checking that the lookup was for the USDOT number now on file. Changing the number to a clean carrier's (or to a revoked one never looked up) still read `clear`. With gap 2, a dispatcher can swap in a clean number and the monitor reports nothing. Fix: a lookup only counts for the number it was made for, and a changed number is `unchecked` until looked up and raises a flag.
4. **A load handed to a factor can be financed again (verified).** Voiding a handed-off batch releases its loads, and the same load went into a new batch immediately. If the factor already advanced against it, that is double financing. Fix: voiding after handoff needs an explicit "the factor was told" confirmation and keeps the loads out of new batches until then, or flags them.
5. **TONU can be claimed for a carrier-caused cancellation on verbal terms (verified).** The eligibility rule checks only that a load was cancelled after dispatch. Evidence names the Relay user who cancelled, not who caused it, and a free-text reason; the carrier manager's own "our truck broke down" produced a claim. Fix: record who cancelled (shipper or broker, carrier, dispatcher) and allow TONU only when the payer did; require a document reference for `verbal` terms or refuse them for claims.
6. **Approvals have no step-up (by reading).** Anyone holding a manager's session can approve a payout change; there is no recent-password or fresh second-factor check. These approvals are what the whole design leans on.

## Medium: wrong, misleading or silent

7. **Truncation is silent (verified in code).** Paperwork readiness, cash and factoring take the newest 200, 200 and 300 loads before filtering. A held-up load older than that is never listed and the totals are quietly partial. Fix: filter in SQL first, page, and say when a list is cut.
8. **The payee is not tied to the factor (verified).** A schedule was prepared with payout details naming "Some Other Person" while the factor was "Fictional Factor Co". Fix: require the payout method to be factor and the payee to match, or show the mismatch and ask for confirmation.
9. **Nobody is told a request is waiting (verified).** `GET /api/change-control/pending` exists and nothing calls it. No notification, attention-strip entry or badge; a pending request waits until someone opens that carrier's files. A request also never expires, and while one is pending a second is refused (`CHANGE_PENDING`).
10. **Most new error codes show a generic message (verified).** Nineteen of the twenty new codes, including `SAME_PERSON`, `VERIFICATION_REQUIRED`, `CLAIM_OPEN`, `TONU_NOT_ELIGIBLE`, `PAYOUT_DETAILS_COOLING_OFF` and `LOAD_NOT_ELIGIBLE`, have no entry in `client-api.ts`, so people see "Something didn't go as planned".
11. **Name matching is too loose (verified).** `sameName("Transport LLC", "Blue Ridge Transport")` is true, as is any containment, and a one-letter name matches everything. A different company's registration can pass as the same.
12. **Insurance "on file" is any positive amount, and MC is not checked (by reading).** The parser does not compare the BIPD amount with the amount required, cargo insurance is not looked at, and sold or hijacked MC numbers (the research's main registration fraud) are invisible because only USDOT is stored.
13. **Cash view labels overstate (by reading).** "You keep" is after the dispatch fee only: factoring discounts and quick-pay fees are not deducted and it does not say so. A draft dispatch invoice counts as "invoiced". "Still to collect" ignores loads with no billing packet yet, so it understates. Days use UTC dates, not the load's time zone.
14. **Factored loads look unpaid forever (by reading).** A load in a handed-off batch still reads "waiting for payment" in the cash view, and nothing records the factor's advance.
15. **Registration job can overrun (by reading).** Fifty carriers at an 8-second timeout each, one after another, can exceed a serverless limit and holds up the rest of the daily job. Repeated lookup failures (four in a row) raise no alert. A manual "Check now" has no cooldown, so a person can hammer the public service.
16. **Terms are unsupported (by reading).** Detention and TONU terms carry no link to the rate confirmation they came from; a manager or dispatcher can type any rate. There is no screen for the carrier-wide claim list (`GET /api/claims` is unused) and no reminder when a submitted claim goes unpaid.

## Lower: coverage and polish

17. **Phone and keyboard coverage is thin.** Browser tests check horizontal overflow of the two Billing tabs and axe on a few states. Nothing exercises the Claims tab, the payout form or the factoring table at 390px, the approve form by keyboard, or where focus goes when the review form closes (the "Review" button it came from disappears).
18. **Registration status shows only in a carrier's files dialog.** It is not on the carrier list, the board or the load, and a dispatcher is not told when a carrier turns to `attention`; only the operations alert goes out, and to the alert webhook.
19. **Retention is undefined** for stored claim evidence, factoring CSVs (kept in the database) and lookup history.
20. **The verification choice is self-attested.** "I called a number already on record" is a statement, not proof; the record keeps who said it and when, which is the most this can do.
21. **Payout details are not used anywhere except factoring.** They do not appear on billing packets or invoices, so the cooling-off protects nothing yet beyond schedules.

## Checked and fine

Cross-carrier isolation and foreign-ID guesses on every new endpoint (tests exist); separation of duties enforced by a database check; idempotent creates; concurrent batches for one load (the second is refused, not a 500); integer money throughout; CSV formula neutralisation; append-only lookups; the demo hides the screens; migrations are expand-only with rollback notes.

## Suggested order

1 to 3 first (they let the controls be walked around), then 4 and 5, then 6 and 10. 7 and 8 next. The rest can follow.
