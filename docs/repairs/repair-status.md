# Repair and verification register — 2026-10-23

## Scope and baseline

The user authorized implementation and pushes to `main` after clarifying the pasted plan's historical approval disclaimer. [The requested plan](2026-10-23-requested-plan.md) is preserved. Work began by fetching and fast-forwarding the clean checkout from `0b83d93` to remote `25c2d77`; existing later implementations were preserved. The plan's reported deployed `9f1b54f` was historical input, not a verified release identity. New API release headers make that comparison possible going forward.

This register distinguishes executable local regression evidence from external release prerequisites. It is not a claim that every control was manually clicked, every provider was contacted, or all 22 packages are production-certified.

## Confirmed repair items

| Item | Result | Evidence |
| --- | --- | --- |
| R-01 date-preserving drilldowns | Implemented | Shared pickup predicates, allowlisted URL state, real browser reload/Back/Forward and selected-carrier checks |
| R-02 exception aggregate scope | Implemented | Headline, type and carrier subtotals reconcile in `repair-reconciliation.test.ts` |
| R-03 stale report identity | Implemented | Persistent successful scope and failed-refresh notice; stale export disabled; recovery browser test |
| R-04 effective current POD | Implemented | Newest document/latest review and expiry predicate shared by reports and Loads; historical accepted/new pending or rejected regression |
| R-05 email acknowledgments | Implemented | Explicit transport availability; recorded/queued/suppressed/accepted/delivered/failure distinctions; integration tests |
| R-06 SMS acknowledgments | Implemented locally | Persisted per-recipient outcome, unknown reconciliation, signed per-attempt callbacks; provider fixture and browser notices; external delivery unverified |
| R-07 exact missing-POD population | Implemented | `missing_pod=true`, delivered status and pickup dates carried to Loads; browser/API regressions |
| R-08 incomplete CSV | Implemented | 5,103-row regression; complete synchronous export or explicit bound failure; durable authorized complete artifacts |
| R-09 billing pagination | Implemented | Separate load/invoice keysets, linked-record recovery and Load more; >100-load regression |
| R-10 exception pagination | Implemented | Stable urgency cursor with microsecond timestamps; all 137 records reached without duplicates |
| R-11 report permissions | Implemented | Navigation and API require dispatcher/carrier-manager membership; admin alone grants no report access; revocation checked |
| R-12 financial metric basis | Implemented | API/UI disclose pickup versus invoice issue dates and current balances; exact invoice drilldown regression |
| R-13 common report snapshot | Implemented | REPEATABLE READ and transaction timestamp; concurrent committed-write regression |
| R-14 actual sub-hourly trigger | Operator prerequisite remains | Workflow and job history exist; missing configured secret fails visibly. Production Actions variable/secret and repeated executions were not configured/verified here |
| R-15 SSL-mode ambiguity | Implemented locally | Remote URLs normalize to verify-full, disable refused; local tests. Hosted certificate trust must pass the deployment build |

## Package-level disposition

| Packages | Work and evidence | Limit |
| --- | --- | --- |
| 01 baseline/action inventory | Baseline above; `npm run audit:actions` registers 529 interactive-control sites and 160 awaited API-call sites, source hashes, handler locations and API conditions in [action-register.json](action-register.json) | Source-linked inventory is not exhaustive runtime/manual coverage |
| 02–03 contracts/permissions | Additive request correlation, friendly error metadata, effective report navigation and revoked-session/export/message checks | Existing domain-specific response contracts remain; no breaking universal response wrapper |
| 04–10 reports/documents/scopes/exports | Canonical definitions, current POD, coherent snapshots, precise drilldowns, persistent stale status, complete durable CSV | Explicit size bounds; hosted upper-bound load testing remains |
| 11–13 communication | Accurate recipient outcomes, readiness gates, idempotent result lookup, signed native provider receipts and browser outcome checks | No live provider credentials enabled or messages sent; sandbox roundtrip remains |
| 14 pagination | Stable Billing/Exceptions continuation and honest loaded summaries | Search/filter values on loaded-only financial summaries are labeled accordingly |
| 15 dispatch/onboarding/fleet/documents | Existing integration suites for load lifecycle, carrier authorization, onboarding, driver scope, assignment conflicts, stop corrections, document versioning and expiry rerun | Actual object store/scanner, regulator verification and physical-device onboarding remain external |
| 16 billing | Existing invariants rerun plus exact report invoice basis, pagination and concurrent overpayment/idempotent retry regression | No funds moved; accounting/provider reconciliation and production-volume benchmarking remain |
| 17 CRM | Existing prospects/contact/conversion/permission integration and browser suites rerun | Not every hand-entered production record was reviewed |
| 18 assistant/admin | Existing consent, scoped tools, human review, organization/account/MFA/session tests rerun; oversized tool responses now keep valid complete records and disclose subsets | Existing ADR 0040 draft creation retained; no operational mutation or new AI authority. Live provider cost/failure checks remain |
| 19 shared UX | Shared UI/tokens preserved, filters recoverable, truthful errors/staleness, accessible metric names, narrow report reflow and keyboard export controls | Automated Chromium/axe is not a complete assistive-technology or cross-engine audit |
| 20 reliability/observability | Correlated sanitized API results, release/schema metadata, job history, callback dedupe/late events, export crash leases | Actual trigger, provider dashboards and external alerts need operator verification |
| 21 security/restore | Dependency audit, permission suites, verified TLS selection, local encrypted restore gate and [runbook](operations-runbook.md) | No independent penetration test, production role separation or offsite recovery certification |
| 22 release | Candidate lint/typecheck/build, migration/backend/browser and restore gates recorded below | Hosted deployment identity and external prerequisites must be checked separately |

## Candidate verification

Final command results are recorded here after the final source changes; prior historical passing tests are not substituted for a candidate run.

- Lint/design-system and TypeScript: passed.
- Migration-aware production build: passed; migrations apply before compilation, no QA seeding in the production-build check.
- Backend: passed, 3 smoke + 301 integration, zero skipped, including fresh migration, authorization, concurrent finance, provider signature and bounded assistant-result tests.
- Browser: passed, all 186 Chromium tests in 4.7 minutes against a production build and a separate fictional local database. Provider results/bucket services/AI are fixtures where specified by their tests.
- Encrypted local backup/restore: passed; all 75 public table counts match and immutable-history enforcement survives restore. Temporary database and files removed.
- Runtime dependency audit: zero production dependency vulnerabilities reported by `npm audit --omit=dev`; no dependency upgrades in this change. This is not a security certification.

The final automated test count is 490 (3 smoke + 301 integration + 186 browser), excluding repeated focused runs. The reporting package was also exported from the Git index and independently passed lint, TypeScript and all 19 report/job regressions before its commit. The action register identifies code revision `f96f080`; the final documentation/CI commit contains the same application source. Hosted checks follow the authorized normal push to the existing `main` deployment and are not implied by these local results.

Repeated testing also found and corrected two fixture defects without relaxing assertions: a load-card selector could click a similarly prefixed carrier name, and token tampering could substitute its existing final hex character. The new accessibility check found a real shared metric accessible-name mismatch; controls now use their full visible content as the name. The concurrent export quota is serialized per actor and regression-tested.

The populated browser database also reproduced an assistant grounding defect: slicing an oversized JSON tool response made it unreadable and the QA assistant incorrectly reported no attention items. [ADR 0056](../decisions/0056-bounded-assistant-results.md) preserves whole records inside the existing context bound, discloses subsets and fails explicit lookup errors. The repaired attention/source browser journey and new integration regression pass. Visual review at 320px found clipped tile labels beyond what axe detected; shared text now wraps, with a label-width regression and [reviewed screenshot](../audits/evidence/repair-report-mobile.png).

Full-suite timing also exposed two UI races: a late unauthorized request could restore a return path after deliberate sign-out, and deferred modal focus restoration could steal focus from an already-focused text field. Sign-out now clears its return path/filters, and restoration yields to the person's next control. MFA, assistant typing and a deterministic deferred-focus regression verify recovery. One billing test selector was updated to the shared metric's natural accessible name; its filter assertions are unchanged.

## Remaining release prerequisites

1. Confirm GitHub/Vercel build success and candidate Git revision; then use a dedicated hosted fictional account for authenticated deployment smoke checks. Workspace credentials do not establish hosted access.
2. Establish and observe the 15-minute trigger (R-14); assign alert ownership for stale/failing jobs and queue/provider backlogs.
3. Explicitly authorize and perform email/SMS sandbox delivery/receipt, invitations/replies, provider failure recovery and consent/opt-out checks before enabling live traffic.
4. Exercise real bucket permissions, quarantine, expiry, malware-scanner outage and document restore using the configured infrastructure.
5. Configure least-privilege production DB roles, encrypted offsite backups/PITR and retention/key recovery; measure an isolated full restore against agreed RPO/RTO.
6. Complete Firefox, WebKit/Safari, physical-device and assistive-technology review; benchmark hosted large datasets, memory, query plans, pool pressure and interrupted work.

No paid provisioning, extra deployment target, live freight, real payment or external message is required to review this patch. The external gates remain open until there is actual evidence for them.
