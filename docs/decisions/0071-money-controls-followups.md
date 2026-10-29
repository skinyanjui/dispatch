# 0071 Money controls follow-ups

Status: accepted, 2026-10-29. Follows audit items 7 to 16 in `docs/audits/2026-10-29-money-controls-audit.md`. Amends ADRs 0064, 0065, 0066, 0067, 0068 and 0069. Migration 047 is expand-only.

## Decision

1. **Lists say when they are cut (0066, 0068, 0069).** Paperwork readiness, cash and factoring scan every load in batches rather than the newest 200 or 300, then list a bounded number. Responses carry `list_truncated` / `scan_truncated` / `totals_partial`, and the screens say so. Factoring lists ready loads however old.
2. **The payee is the factor (0069).** A schedule is refused (`PAYOUT_NOT_TO_FACTOR`) unless the active payout details name the factor.
3. **Approvers are told, and requests lapse (0064).** Asking creates an `approval_request` notification for each eligible approver and the app shows a waiting count. A request still pending after seven days expires lazily on the next read and by the daily job.
4. **Every error code has plain words (client-api).** A test fails if a code raised by the money controls has no friendly message.
5. **Name matching compares distinguishing words (0065).** Generic suffixes (LLC, Transport, Trucking…) are ignored; at least one distinguishing word must match and short names never match by containment.
6. **Insurance and MC are judged (0065).** Insurance is compared with the amount required, not "any positive amount"; the MC number is stored on the carrier (`carrier_profiles.mc_number`), looked up, and flagged if it belongs to another carrier or is not found.
7. **Cash labels are honest (0066).** "After our fee" does not claim to be what the carrier keeps. Draft invoice fees are labelled draft, delivered loads with no billing packet are shown as "Not billed yet", and loads handed to a factor have their own stage ("With the factor") instead of looking unpaid.
8. **The registration job stays inside a budget (0065).** It checks the oldest lookups first within a time and concurrency budget and defers the rest; repeated failures raise an operations alert; "Check now" has a cooldown (`AUTHORITY_CHECK_COOLDOWN_SECONDS`).
9. **Claim terms are supported (0067).** Terms whose source is the rate confirmation store `detention_terms.document_version_id`, resolved on the server from the load's accepted rate confirmation (`RATE_CONFIRMATION_REQUIRED` otherwise). The evidence and PDF packet name the file, its version and hash. Billing has a **Claims** tab listing every claim for the carrier (`GET /api/claims`, 200 newest, `list_truncated`) with totals and a flag for sent claims waiting 14+ days. It is hidden in the browser-only demo.

## Consequences

Terms on older loads that cite the rate confirmation keep no file link; the tab says so and a new claim on them is refused until terms are saved again against an accepted rate confirmation. Scans cost more queries on large carriers; batch size is bounded. Rollback: leave migration 047's columns; revert the code paths named above.
