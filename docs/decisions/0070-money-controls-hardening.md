# 0070 Money controls hardening

Status: accepted, 2026-10-29. Follows the audit in `docs/audits/2026-10-29-money-controls-audit.md` (items 1 to 6). Amends ADRs 0064, 0065, 0067 and 0069.

## Decision

1. **Contact links are guarded as well as details (0064).** For a contact linked to a carrier, a change to its phone, its email or its carrier link (unlinking or moving it) waits for a second person, and a reason is required. The contact keeps its old values and link until approved. Asking needs access to the target carrier; approving a move needs an approver who answers for both carriers (an organization admin, or a manager of both) and the carrier must be in the same organization (`TARGET_CARRIER_APPROVAL_REQUIRED`). Contacts never linked to a carrier are still edited directly.
2. **Carrier setup details are guarded (0064).** Once setup is complete, a change to the carrier's name, contact email, phone or USDOT number is a new change kind, `carrier_profile` (migration 046). The contact person's own name applies at once. Approval re-checks that nothing moved meanwhile and revokes manager invitations addressed elsewhere, as a direct save does. During setup the dispatcher still fills the details in directly.
3. **A lookup speaks only for the USDOT number it was made for (0065).** Status, the operations alert and the daily job read lookups for the number now on file. After the number changes, status is `attention` with a "USDOT number changed" flag until the new number is looked up; the job looks it up at once.
4. **A schedule handed to a factor cannot be silently re-financed (0069).** Cancelling a handed-off schedule needs the carrier to confirm the factor was told, and its loads stay held (`held_after_handoff`) until a separate, audited release in which the carrier confirms the factor has not advanced against them. A schedule that was only prepared still frees its loads at once.
5. **TONU needs the payer's cancellation and written terms (0067).** Cancelling a dispatched load records who cancelled (`loads.cancel_party`: payer, carrier, dispatch, other) and is refused without it. A TONU claim needs `payer`; a cancellation by anyone else, or one with no recorded party (older records), is not claimable. A fee agreed only verbally (`source: verbal`) is not claimed. The packet states who cancelled.
6. **Approvals need step-up (0064).** Approving (not rejecting) a change requires the approver's password again and, if they use two-step verification, a current code or recovery code. Only failures count: six wrong tries in five minutes block approvals for that person even with the right password. An account with no usable password cannot approve until it sets one.

## Consequences

A dispatcher who edits a finished carrier's email now waits for the carrier's manager or an admin. Older cancelled loads cannot support TONU claims. People who sign in only through a provider (no password) must set a password before approving. Self-attested "who cancelled" and "factor confirmed" are statements, recorded with who said them and when, not proof. Rollback: leave the columns (046); revert the guarded paths and the step-up in `change-control.ts`.
