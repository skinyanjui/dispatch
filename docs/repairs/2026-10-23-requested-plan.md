> Execution authorized by the user in chat on October 23, 2026: “Implement and push to main.” The original plan below is preserved, including its earlier planning-only disclaimer. Current implementation evidence and remaining external prerequisites are in repair-status.md.

# Relay Dispatch — Complete Repair and Implementation Plan

**Project:** Relay Transportation Management System (TMS)  
**Repository:** [skinyanjui/dispatch](https://github.com/skinyanjui/dispatch)  
**Application:** https://dispatch-nine-pearl.vercel.app  
**Prepared:** October 23, 2026  
**Scope:** Full-stack repairs, API reliability, user actions, operational workflows, data integrity, UX, accessibility, security, testing, and deployment readiness.

**Execution status:** Planning only. No source files, databases, commits, or deployments have been modified.

---

## 1. Executive objective

Repair Relay as a single, coherent dispatch-management platform rather than applying isolated fixes to individual pages.

Every user action must produce a predictable and verifiable outcome across the application.

The required operating principle is:

**User action → validation → authorization → business rules → database transaction → domain event → integration or background job → verified result → synchronized interface.**

The repair must achieve six outcomes:

1. Every visible action is functional, correctly restricted, and connected to its intended result.
2. Reports, operational records, documents, and billing use consistent authoritative data.
3. Users can complete workflows without losing filters, selections, drafts, or navigation context.
4. Errors, unavailable integrations, and uncertain outcomes are handled without duplicate transactions or misleading success messages.
5. Each page behaves consistently across desktop, tablet, and mobile.
6. The system has sufficient automated verification and operational visibility to support controlled production use.

**Do not rebuild the application.** Preserve the existing Next.js, TypeScript, PostgreSQL, and modular-monolith architecture. Correct root causes within its domain modules.

## 2. Verified baseline

The inspected production deployment uses commit `9f1b54f`. At the most recent repository check, `main` was at `25c2d77`, four commits ahead of the inspected deployment, involving layout, mobile navigation, and associated tests.

Reconcile deployment and repository versions before implementation. Do not treat an undeployed change as a production repair.

The current application already includes substantial functionality:

- Authenticated workspace and carrier-scoped access
- Load board, table, calendar, and saved views
- Driver and vehicle management
- Carrier onboarding and dispatch authorization
- Multi-stop loads, manual check-ins, and event history
- Document uploading, versions, review, and scanning interfaces
- Exceptions and operational attention indicators
- Inbox, contacts, email/SMS abstractions, and notification queues
- Carrier freight billing and dispatch invoices
- Reports, CSV exports, and an assistant
- Organization, account, audit, and scheduler interfaces
- Automated integration and Playwright browser tests

Preserve these implementations where sound.

### 2.1 Confirmed repair items

| ID | Priority | Defect | Required result |
|---|---|---|---|
| R-01 | P1 | Reports drill-downs discard date filters | Open precisely the records represented by the selected metric |
| R-02 | P1 | Carrier exception aggregates use a different scope from report totals | Reconcile all totals and subtotals |
| R-03 | P1 | Failed report refreshes retain old data without a persistent stale-state distinction | Never misrepresent old results as current |
| R-04 | P1 | Missing-accepted-POD reporting can count an accepted historical version | Use the current effective document version |
| R-05 | P1 | Inbox can display “Message sent” when an email is only recorded, queued, or suppressed | Show the actual processing state |
| R-06 | P1 | SMS action acknowledgment does not communicate the final recorded provider outcome | Distinguish accepted, failed, and unknown outcomes |
| R-07 | P1 | The missing-POD shortcut uses a general paperwork filter | Open exactly the missing-POD population |
| R-08 | P2 | CSV export caps results at 5,000 without visible completeness feedback | Provide complete export or explicit partial-export handling |
| R-09 | P2 | Billing loads only the latest 100 records without full pagination | Make every authorized eligible load discoverable |
| R-10 | P2 | Exceptions returns a truncated 100-record set without continuation | Implement server-side pagination |
| R-11 | P2 | Report navigation permissions do not entirely match API membership requirements | Align navigation and server authorization |
| R-12 | P2 | Current-state receivables and period-based reporting are not clearly distinguished | Define the accounting basis of every financial metric |
| R-13 | P2 | Separate report queries do not guarantee a common read snapshot | Prevent inconsistent point-in-time aggregates |
| R-14 | P2 | The 15-minute scheduled job is implemented but not established by the daily Vercel cron | Enable and verify an appropriate sub-hourly trigger |
| R-15 | P3 | PostgreSQL connection configuration emits SSL-mode warnings | Correct and validate connection security settings |

These are based on the inspected application and deployed-source implementation, not on a complete manual click-through of every authenticated page.

### 2.2 Findings requiring reproduction

The following are verification targets, not established production defects:

- Every toolbar, button, menu, table-row action, shortcut, and form submission
- Provider-delivery behavior with actual external credentials
- Carrier and driver invitation delivery
- Document download, upload, and scanning against real infrastructure
- Full billing and payment reconciliation under concurrency
- Vehicle assignment conflicts and retirement under active dispatch
- Membership revocation during an active user session
- AI provider failure, cost limits, and grounding
- Cross-browser and assistive-technology behavior
- Large datasets, slow connections, and recovery after interrupted requests

Do not close these items based on reading source code alone.

---

# 3. Target system architecture

Preserve a modular monolith with the following responsibilities.

| Layer | Responsibility | Repair requirement |
|---|---|---|
| Presentation | Pages, record inspectors, navigation, forms | Consistent actions and states |
| Client state | Drafts, filters, selection, pending requests | Context preservation, request cancellation, synchronization |
| API contracts | Input/output validation | Typed contracts, stable errors, predictable responses |
| Authorization | Organization, carrier, role, record scope | Server-side, least-privilege enforcement |
| Domain services | Load, document, billing, messaging rules | One authoritative implementation per business rule |
| Data access | PostgreSQL transactions, queries, locking | Consistent records, constraints, efficient pagination |
| Domain events | Audit, notifications, integrations | Durable events associated with committed transactions |
| Integrations | Email, SMS, AI, storage, provider observations | Observable delivery and failure handling |
| Operations | Scheduler, monitoring, support, recovery | Retries, reconciliation, alerts, health and runbooks |

Shared UI components stay in `src/components/ui`. Domain-specific code stays in its corresponding component and `src/lib` modules.

Avoid introducing separate services, a new frontend framework, or a second data store without an operational requirement.

---

# 4. Phase 0 — Establish the repair baseline

**Priority:** P0 prerequisite  
**Dependency:** None

### Tasks

**P0-01 — Verify exact release state**

- Identify the currently deployed commit.
- Compare it with the intended implementation baseline.
- Verify the latest schema migration applied in each environment.
- Identify which provider integrations are configured versus simulated.
- Record application version, schema version, and deployment identifier together.

**P0-02 — Build a complete action inventory**

Inspect every workspace page, nested record screen, account screen, and public authentication route.

For every interactive element record:

- Page and user role
- User intent and expected outcome
- UI component and handler
- API method and endpoint
- Authorization requirement
- Domain service and database records
- Events, notifications, or external effects
- Current behavior and reproducible failure
- Required correction and automated test

**P0-03 — Prepare isolated test fixtures**

Create disposable organizations containing dispatchers, administrators, carrier managers, and drivers.

Include loads in every status, revoked memberships, expired agreements, missing and rejected documents, partial payments, overdue exceptions, failed notifications, and multiple carriers with substantial record volume.

**P0-04 — Capture failure evidence**

Record request/response details, browser errors, server logs, database outcomes, and screenshots.

Do not submit real outbound messages or payments to test an action. Use fixtures and provider sandboxes unless a specific live test is authorized.

### Completion criteria

A complete, reproducible action register exists, with no unexplained control or undocumented state-changing API action.

---

# 5. Phase 1 — Repair API contracts, authorization, and shared state

**Priority:** P1  
**Dependencies:** Phase 0

### P1-01 — Standardize action responses

Adopt a typed action response pattern for consequential operations.

Required information, as applicable:

| Property | Purpose |
|---|---|
| `id` | Stable affected record ID |
| `status` | Actual resulting domain state |
| `version` | Updated optimistic-concurrency version |
| `operationId` | Traceable mutation identifier |
| `processingState` | Whether downstream processing is pending or complete |
| `warnings` | Nonblocking issues requiring attention |
| `requestId` | Support and diagnostic correlation |

Not every endpoint needs every field. Use domain-specific DTOs and a shared error convention.

Never return a success message that implies external completion when the API only established persistence.

### P1-02 — Standardize errors

Implement consistent error codes and recovery behavior:

| Error condition | Expected client behavior |
|---|---|
| Invalid input | Field-level explanation and preserved form entries |
| Authentication expired | Reauthenticate while preserving safe return context |
| Permission denied | Explain lack of permission without disclosing unauthorized records |
| Record not found | Clear unavailable state and return navigation |
| Version conflict | Refresh the affected record and reconcile unsaved edits |
| Unavailable provider | Explain what was saved and what was not delivered |
| Network failure | Retry safely without duplicating a completed operation |
| Rate limit | Respect `Retry-After` where supplied; avoid repeated automatic submissions |
| Unknown operation result | Reconcile by idempotency key or operation ID before retrying |

Review `src/lib/client-api.ts` and `src/app/api/[...path]/route.ts`.

### P1-03 — Unify authorization contracts

Make effective permissions a shared server-defined concept, enforced by domain services.

Resolve whether organization administrators without carrier membership may access carrier-wide reports and operational records. Choose one explicit policy and implement it consistently.

Test direct URLs, API calls, exports, attachment downloads, background jobs, and AI source access.

### P1-04 — Establish URL-addressable state

Introduce validated query parameters for navigable scopes such as:

`from`, `to`, `carrier_id`, `status`, `owner`, `attention`, `sort`, and cursor.

State should survive refresh, Back/Forward, opening records, and returning to the originating page.

Do not put sensitive tokens or private message content into URL parameters.

### Completion criteria

Every authorization decision is enforced server-side. Each mutation has a predictable response, error, and retry behavior.

---

# 6. Phase 2 — Repair Reports completely

**Priority:** P1  
**Dependencies:** Phase 1

**Primary files:**

- `src/lib/reports.ts`
- `src/components/reports.tsx`
- `src/components/dispatch-workspace.tsx`
- `src/lib/load-summary.ts`
- `src/lib/loads.ts`
- `tests/integration/reports.test.ts`
- `tests/integration/flow-reconciliation.test.ts`

### P2-01 — Define metric semantics

Create a reporting specification for each metric.

| Metric | Canonical definition |
|---|---|
| Loads | Noncancelled loads with first pickup in the selected UTC range |
| Cancelled | Loads cancelled within the defined pickup cohort; explicitly separate from noncancelled total |
| Freight value | Sum of eligible agreed load rates, in minor units |
| Pickups on time | Latest effective recorded pickup arrivals within appointment windows |
| Deliveries on time | Latest effective recorded delivery arrivals within appointment windows |
| Not reported | Eligible past-due stops without an effective arrival report |
| Open exceptions | Unresolved exceptions associated with the specified load cohort, as labeled |
| Missing accepted POD | Delivered loads without a currently accepted effective POD version |
| Dispatch invoices issued | Issued invoices within the specified issue-date range |
| Outstanding dispatch fees | Unpaid issued invoice balances, with an explicitly labeled date/cohort basis |
| Carrier freight billed | Submitted carrier billing packets under the defined load scope |
| Carrier freight outstanding | Reported unpaid packet amounts, clearly distinguished from Relay-held money |

For multi-stop loads, distinguish stop-level rates from load-level rates and report their denominators.

### P2-02 — Create canonical report scopes

Build one server-side scope definition for carrier authorization, dates, and eligible loads.

Reuse it for:

- Headline metrics
- Carrier totals
- Weekly summaries
- Exception counts
- CSV export
- Drill-down record lists

Where exception or invoice metrics require a different date basis, declare that difference rather than implicitly reusing the pickup-date scope.

### P2-03 — Fix document readiness

Determine accepted-POD state using the newest effective document version and its latest applicable review.

Reuse the document domain's canonical status logic rather than introducing another interpretation in reporting SQL.

Add test cases for accepted v1 followed by pending, rejected, or accepted v2.

### P2-04 — Repair drill-down actions

Every metric opens exactly the underlying matching records.

For example, Delivered without accepted POD should open the relevant delivered loads with a missing-effective-POD criterion—not every load with any paperwork problem.

When a destination page cannot represent the exact metric's population with existing filters, extend its API and filtering model.

Preserve the source date range, carrier, and return navigation.

### P2-05 — Eliminate stale result ambiguity

Attach a successful filter identity to the report payload.

On request failure:

- Retain previous data only if clearly labeled stale.
- Show which filters produced those results.
- Provide Retry.
- Do not announce “Report loaded.”
- Do not enable an export as though it reflects a newly failed filter.

Ignore superseded requests when users rapidly change filters.

### P2-06 — Correct export behavior

Remove silent truncation.

Support reliable cursor-based or streamed exports, with practical resource limits and explicit completion status.

For exports exceeding synchronous limits, use a durable export job with expiration, authorization checks, and a downloadable result.

Keep spreadsheet formula-injection protection and audit each export.

### P2-07 — Improve report consistency

Use a common read snapshot for related metrics where concurrent changes can otherwise create contradictory totals.

Validate strict calendar dates and inclusive/exclusive UTC boundaries. Document the reporting timezone and preserve date semantics across daylight-saving transitions.

### Completion criteria

Every report count matches the records returned by its drill-down. Every financial subtotal reconciles, and users cannot mistake partial or stale data for complete current results.

---

# 7. Phase 3 — Repair Inbox, messaging, and notifications

**Priority:** P1  
**Dependencies:** Phase 1

**Primary modules:** `messaging.ts`, `notifications.ts`, `sms.ts`, `inbox.tsx`, API routes, and provider adapters.

### P3-01 — Distinguish message states

Define one consistent delivery lifecycle:

**Recorded → Queued → Submitted to provider → Provider accepted → Delivered (if confirmed)**

Also support Failed, Suppressed, and Unknown.

Provider acceptance must not be equated with recipient delivery.

### P3-02 — Correct Send acknowledgment

Email and SMS actions must return accurate persisted/processing results.

The current generic “Message sent” confirmation is insufficient when an outbound email can be suppressed for missing transport configuration.

Disable unavailable delivery modes where practical, explain the missing capability, and never silently convert an attempted send into a manual log.

### P3-03 — Repair retries and uncertain outcomes

- Preserve idempotency keys across network failures.
- Reconcile existing messages before retrying.
- Prevent duplicate provider attempts after ambiguous responses.
- Require explicit confirmation for an SMS with an unknown delivery result.
- Track each recipient's delivery state separately.
- Show actionable recovery for definite provider failures.

### P3-04 — Verify conversation behavior

Test compose, recipient selection, saved replies, unread/read, archive, trash, restore, attachments, load association, search, and channel filtering.

Maintain one thread per intended conversation rather than accidentally fragmenting communication between screens.

### P3-05 — Complete external communication integration

Verify actual email and SMS provider round trips in controlled sandbox/live-test environments.

Add provider-status webhooks where supported, with signature verification, deduplication, ordering tolerance, retry handling, and replay protection.

Verify inbound email, replies, SMS opt-out handling, and attachment processing independently.

### P3-06 — Repair notification operations

Show whether a notification was queued, suppressed, failed, or accepted by the provider.

Expose retry exhaustion to authorized support operators. Add delivery failures and scheduled-job failures to monitoring without exposing private message bodies in logs.

### Completion criteria

No message is shown as delivered without sufficient evidence. Duplicate submissions cannot produce duplicate messages or unapproved external sends.

---

# 8. Phase 4 — Repair operational workflows

**Priority:** P1/P2  
**Dependencies:** Phases 1–3

## 8.1 Loads

Trace:

**Create → assign → dispatch → pickup → in transit → delivered → paperwork → billing**

Repair and verify:

- Carrier agreement and role prerequisites
- Draft creation and validation
- Multi-stop order, time zones, and appointment bounds
- Driver and vehicle eligibility
- Concurrent assignment changes
- Drag-and-drop milestone transitions
- Manual arrival/departure and check-in amendments
- Load edits, cancellation, and change requests
- Saved views and pagination
- Document, exception, and billing links
- Recovery after a save succeeds but subsequent refresh fails

Enforce the stage transition graph server-side. Never rely only on disabled client controls.

## 8.2 Exceptions

Trace:

**Detect → open → classify → assign → investigate → resolve/reopen → synchronize**

Repair and verify:

- Exact record-level navigation
- Due dates, owner, severity, and status
- Unassigned and overdue filters
- Pagination beyond 100 results
- Concurrency/version conflicts
- Notifications and audit events
- Correct counts in Reports and Loads

Resolved exceptions must remain in the audit history.

## 8.3 Carriers and onboarding

Trace:

**Prospect → carrier record → agreement review → membership → driver invitation → dispatch eligibility**

Repair and verify:

- Signed agreement version and expiration
- Complete versus incomplete onboarding
- Cross-carrier identity and access
- Duplicate invitations and revoked invitations
- Expired insurance and other compliance documents
- Authorization revocation effects
- Converted prospect identity and history
- Carrier load and exception counts

## 8.4 Fleet

Trace:

**Create vehicle → associate carrier → make available → assign → complete → retire**

Repair and verify:

- Driver and vehicle belong to the authorized carrier
- An unavailable or retired vehicle cannot be newly assigned
- Retirement cannot silently invalidate active dispatch operations
- Vehicle availability reflects active assignments
- Updates propagate between Fleet and Loads
- Drivers receive only permitted vehicle and load information

## 8.5 Documents

Trace:

**Upload → verify → scan → store → version → review → accept/reject → update readiness**

Repair and verify:

- Content type, size, checksum, malware scanning
- Direct-upload session expiration and cleanup
- Upload recovery on poor connections
- Immutable version and review history
- Accepted-current-version logic
- Secure download authorization
- Readiness updates throughout Loads, Reports, and Billing

Resumable upload support should be added for larger documents rather than forcing a complete restart after every interruption.

### Completion criteria

Each operational task can be completed directly from its relevant record, and all dependent surfaces reflect the resulting state.

---

# 9. Phase 5 — Repair finance, CRM, AI, and administration

**Priority:** P2  
**Dependencies:** Phases 1–4

## 9.1 Billing

Maintain two distinct workflows:

**Carrier freight billing:** billing packet, submission, carrier-reported payment receipts.

**Relay dispatch-service billing:** fee calculation, invoice, issue/void, payment, outstanding balance.

Required repairs:

- Replace the Billing 100-load result cap with cursor-based pagination.
- Batch document-readiness queries to avoid per-load query growth.
- Reconcile invoice lines, totals, receipts, and balances.
- Preserve invoice and payment idempotency.
- Block overpayments and invalid transitions.
- Prevent duplicate active invoicing of a load.
- Verify all calculations with integer minor units.
- Add clear outstanding/overdue definitions and aging views.
- Verify invoice access, payment permissions, and audit history.

For production operations, separately scope missing commercial capabilities such as invoice PDF/email delivery, accounting export, credits, adjustments, and bank reconciliation. Do not introduce payment custody into this dispatch platform.

## 9.2 Prospects

Verify stage changes, ownership, follow-up dates, activity history, conversion, archive, and restored access.

Prevent duplicate carrier creation during conversion and preserve the source prospect relationship.

CRM calendar/email synchronization is an integration enhancement, not a prerequisite to fixing existing prospect actions.

## 9.3 Assistant

The assistant must remain read-only unless an explicitly authorized capability is later introduced.

Test:

- Organization and carrier scoping
- Access after membership revocation
- Citation/source correctness
- Unknown or conflicting data
- Provider unavailability
- Monthly budgets and request limits
- Repeated submissions
- Conversation history access
- Navigation to the exact cited record

Never allow generated answers to mutate bookings, documents, invoices, messages, or payments implicitly.

## 9.4 Account and organization

Verify sign-in, sign-out, password reset, email verification, MFA, recovery codes, staff invitations, organization profile updates, and membership removal.

Add active-session visibility and session revocation as a production-hardening work item.

Decide whether organization policy requires enforced MFA for particular roles.

Ensure role changes invalidate appropriate access without requiring users to manually sign out first.

## 9.5 Audit and scheduler

Verify audit filters, pagination, actor identity, record attribution, and denied-access history.

The current scheduler code supports a 15-minute tick, but the Vercel configuration uses a daily cron. Establish one supported sub-hourly trigger before relying on time-sensitive reminders.

Monitor last execution, last success, failure, and staleness.

### Completion criteria

Financial records reconcile, administrative permissions take effect reliably, and AI or background features cannot bypass domain authorization.

---

# 10. Phase 6 — Repair and standardize every page's UX

**Priority:** P2  
**Dependencies:** Stable workflows and contracts

Preserve the existing Relay visual language, the shared design system, and compact component sizes.

### Page-level repair matrix

| Page | Required UX outcome |
|---|---|
| Loads | Clear operational priorities, stage controls, responsive list/board/calendar, and direct record actions |
| Exceptions | Owner, severity, deadline, next action, and resolution readily accessible |
| Inbox | Delivery-aware message states, stable conversation selection, reliable compose and reply |
| Contacts | Contextual communication actions with correct channel availability |
| Carriers | Visible authorization/compliance status and direct paths to required actions |
| Fleet | Driver/vehicle status and eligible assignments immediately understandable |
| Prospects | Clear pipeline, owner, next follow-up, and conversion flow |
| Assistant | Focused chat, source records, provider status, and transparent limitations |
| Documents | Templates, drafts, and load paperwork clearly distinguished |
| Billing | Separate carrier and dispatch billing, actionable balances, consistent payment states |
| Reports | Filterable, reconcilable metrics with exact drill-downs |
| Notifications | Distinct notification status, preferences, retries, and delivery history |
| Account | Clear profile/security settings and recovery |
| Organization | Role permissions, memberships, invitations, and destructive confirmations |
| Audit log | Searchable events, useful filters, and operational failure visibility |

Public authentication, onboarding, marketing, pricing, and legal pages also require validation of their navigation, forms, accessible states, claims, and actual availability of advertised capabilities.

### Shared interaction requirements

Every relevant UI component must handle:

- Initial state
- Loading state
- Empty state
- Partial or stale data
- Success
- Field validation error
- Permission denied
- Network/server failure
- External integration unavailable
- Destructive confirmation
- Recovery or retry

Prefer inline actions and preserved context over unnecessary modals.

Use shared `DataTable`, `StatTile`, `ToggleGroup`, `ErrorAlert`, `EmptyState`, and the other existing UI primitives instead of creating page-specific duplicates.

### Accessibility verification

Target WCAG 2.2 AA.

Check semantic names, focus order, keyboard operation, Escape behavior, table semantics, screen-reader status announcements, contrast, target sizes, and zoom at 200–400%.

Test at least Chromium, Firefox, Safari/WebKit, and representative physical mobile devices before a full production release.

### Completion criteria

Users can discover, execute, and recover from every important action without unnecessary navigation or ambiguous feedback.

---

# 11. Phase 7 — Security, infrastructure, and operational reliability

**Priority:** P1 for production readiness  
**Dependencies:** All affected feature changes

### Security

- Enforce least-privilege authorization in every API and database query.
- Test organization/carrier isolation across direct IDs, exports, attachments, and assistant retrieval.
- Review CSRF, XSS, SSRF, SQL injection, upload protections, session handling, and dependency risks.
- Validate provider webhook signatures and replay prevention.
- Review existing rate limits for high-cost or high-abuse operations.
- Harden PostgreSQL connection encryption and certificate validation.
- Restrict production database roles and migration permissions.
- Record security-relevant changes in audit history.

### Reliability

- Use timeouts and bounded retries for external dependencies.
- Preserve idempotency across uncertain client/server outcomes.
- Ensure event and notification records are durable.
- Make job retries visible.
- Detect stuck, abandoned, or failed background operations.
- Reconcile provider acknowledgments against local delivery records.
- Define recovery for partially completed document and messaging operations.

The existing transactional outbox does not need a generic consumer until an integration requires event publication. Once introduced, its dispatcher must have durable acknowledgments, retries, deduplication, and failure visibility.

### Observability

Introduce structured telemetry for:

- API errors by route and cause
- Authorization denials
- Load creation and milestone failures
- Document upload and scanning failures
- Message provider failures and unknown outcomes
- Invoice/payment validation conflicts
- Job execution and staleness
- Database latency and pool exhaustion
- Report performance and reconciliation failures

Avoid sensitive document contents, message bodies, MFA secrets, and credentials in telemetry.

### Data operations

Define retention/deletion and backup policies for documents, messages, account/session data, audit records, and integration events.

Implement encrypted backup procedures, periodic restore tests, recovery runbooks, and secret/key rotation procedures.

### Completion criteria

An authorized operator can identify a failure, understand its effects, and recover without direct database manipulation or unsafe duplicate actions.

---

# 12. Data and migration strategy

Prefer code/query repairs where no schema change is required.

| Change | Expected data impact |
|---|---|
| Correct report scopes and filters | Usually query/API change; add indexes if query plans require |
| Latest-effective document readiness | Query/domain correction; potential indexes |
| Accurate message delivery states | Reuse existing delivery tables first; migrate only for missing metadata/states |
| Pagination | Stable ordering, indexes, and opaque cursors |
| Action idempotency | Reuse existing keys and unique constraints; add storage only where missing |
| Session management | Extend existing session model if required |
| Observability | Operational metadata, not unnecessary duplicated business records |
| External provider adapters | Provider IDs, attempt records, webhook deduplication, and consent records where needed |

Any required schema migration follows:

**Expand schema → migrate → backfill → verify → compatibility window → deploy readers/writers → remove obsolete paths.**

Backfills must be idempotent and restartable. Large operations must be batched. Indexes should be introduced with deployment-safe methods appropriate to the target PostgreSQL environment.

Never delete audit history or immutable document versions as a convenient rollback strategy.

---

# 13. Test plan and quality gates

## 13.1 Unit tests

Test deterministic business rules, validation, metric calculations, date handling, authorization decisions, formatting, and status transitions.

## 13.2 Database integration tests

Cover transactions, constraints, tenant isolation, concurrent updates, idempotency, effective document versions, invoice reconciliation, report consistency, and pagination.

## 13.3 API contract tests

For each endpoint, verify successful responses and relevant 400, 401, 403/404, 409, 422, 429, and 503 behavior.

Test malformed requests, foreign IDs, missing prerequisites, stale versions, and partial provider failures.

## 13.4 Browser end-to-end tests

Use Playwright to exercise full flows rather than isolated page rendering.

Mandatory journeys:

1. Onboard carrier through successful dispatch eligibility.
2. Create and dispatch a load.
3. Record pickup, delivery, and corrections.
4. Flag and resolve an exception.
5. Upload, version, and accept paperwork.
6. Submit carrier billing and record a receipt.
7. Issue a dispatch invoice and record a payment.
8. Reconcile all corresponding Reports figures.
9. Send and receive Relay communication.
10. Verify email/SMS queued, accepted, failed, and unknown statuses.
11. Convert a prospect into a carrier without duplication.
12. Revoke a user's membership while their session remains active.
13. Open report drill-downs with preserved filters.
14. Complete a workflow on mobile with an interrupted connection.

## 13.5 Scale, performance, and failure tests

Test representative workloads, including at least:

- Thousands of loads across multiple carriers
- More than 100 actionable exceptions
- More than 100 billing-eligible loads
- More than 5,000 export records
- Concurrent document reviews
- Concurrent milestone and payment attempts
- Large conversation histories
- Provider timeouts and duplicate webhook delivery

Verify pagination stability, query plans, response sizes, database connection pressure, and recovery behavior.

## 13.6 Release gates

Require:

- Lint pass
- Typecheck pass
- Unit and integration test pass
- Relevant database migration/backfill test pass
- Browser regression pass
- Production build pass
- Authorization isolation pass
- Reconciliation pass
- Accessibility review
- Security/dependency review
- Controlled deployment and smoke-test pass

Do not assume historical successful tests still pass after these changes. Re-run them against the resulting candidate.

---

# 14. Implementation work packages and dependencies

Each work package should be independently testable and include affected UI, API, domain, data, and documentation changes.

| Order | Package | Priority | Depends on |
|---|---|---|---|
| 01 | Release baseline and full action inventory | P0 | — |
| 02 | Shared API error/action contracts | P1 | 01 |
| 03 | Effective permissions and role reconciliation | P1 | 01 |
| 04 | Canonical reporting definitions | P1 | 02–03 |
| 05 | Current document-version readiness | P1 | 04 |
| 06 | Reporting scope and aggregate reconciliation | P1 | 04–05 |
| 07 | Date-aware Loads and Exceptions APIs | P1 | 04 |
| 08 | Exact metric drill-down navigation | P1 | 06–07 |
| 09 | Report stale/error-state repair | P1 | 02, 06 |
| 10 | Complete and auditable CSV exports | P2 | 04, 07 |
| 11 | Accurate message delivery states | P1 | 02 |
| 12 | Provider readiness, retries, and reconciliation | P1 | 11 |
| 13 | Communication workflow browser tests | P1 | 11–12 |
| 14 | Billing and Exceptions server-side pagination | P2 | 02 |
| 15 | Dispatch, carrier, fleet, and document flow reconciliation | P1 | 03, 05 |
| 16 | Billing invariants and performance | P1 | 05, 14–15 |
| 17 | Prospects and CRM conversion verification | P2 | 03, 15 |
| 18 | Assistant and administration verification | P2 | 03 |
| 19 | Shared navigation, UX states, and accessibility | P2 | 08–18 |
| 20 | Scheduler/provider reliability and observability | P1 | 11–18 |
| 21 | Security, backup, restore, and operational runbooks | P1 | 02–20 |
| 22 | Full cross-module regression and release validation | P0 gate | All |

Do not combine unrelated packages into one oversized change. Validate each package before building dependent work on top of it.

---

# 15. Rollout strategy

### Stage A — Correctness first

Complete Packages 01–13 in a controlled QA environment.

Confirm reporting, permissions, and message acknowledgments before any design-only changes.

### Stage B — Operational workflows

Complete Packages 14–18.

Verify the same records remain consistent across Loads, Exceptions, Carriers, Fleet, Documents, Billing, and Reports.

### Stage C — User experience and operations

Complete Packages 19–21.

Retain existing functionality while improving UI consistency, accessibility, security, and observability.

### Stage D — Production verification

Run the full release gate and validate the deployed candidate using fictional test records.

Before a production change, confirm:

- Target deployment commit and environment
- Schema version and backup
- Environment/provider configuration
- Feature flags and migration compatibility
- Rollback and recovery procedures
- Availability of monitoring and responsible operators

Use staged rollout when a repair changes persisted data, authentication, messaging, financial behavior, or a shared API contract.

A rollback must restore compatible application behavior without destroying valid business events.

---

# 16. Final acceptance criteria

Relay's repair is complete when:

1. **All visible controls work as intended** or are explicitly and correctly marked unavailable.
2. **No false success messages exist.** A recorded action is not presented as an externally completed action.
3. **All API operations are authorized and validated** at the server boundary.
4. **Reports reconcile against source records**, including documents, exceptions, billing, and date filters.
5. **Every drill-down displays the records behind its metric.**
6. **No records disappear because of hidden list limits or incomplete pagination.**
7. **Actions are safe under retries and concurrent requests.**
8. **Financial totals remain exact**, with separated carrier and dispatch-service accounting.
9. **Navigation preserves context**, and return actions recover the originating workflow.
10. **Mobile, keyboard, and assistive-technology interactions are verified.**
11. **Background jobs and integrations expose their real processing states.**
12. **Operational errors are observable, actionable, and recoverable.**
13. **Migrations, security, backups, and release procedures are tested.**
14. **Automated regression coverage protects the repaired workflows.**
15. **All production release gates pass with no unresolved P1 defects.**

## 17. Scope control

Fixes to existing functionality come first.

New telematics, advanced ETA prediction, accounting integrations, full CRM calendar synchronization, payment custody, and other large product expansions should not delay repair of currently advertised workflows unless a specific feature is required for safe or truthful operation.

No real carrier, customer, provider, message recipient, or financial account should be activated as part of testing without explicit authorization.

## 18. Final execution directive

Implement this plan in dependency order, beginning with reproducible defects and authoritative data contracts.

For each package, trace all affected layers, implement the root-cause correction, add regression coverage, verify failure and recovery behavior, and update technical/operational documentation.

**The target is not merely a clean interface or passing build. It is a system in which every user action, API response, persisted record, background operation, and displayed result agrees.**

**This document is the repair plan only. No implementation, commit, push, or deployment is authorized by creating it.**