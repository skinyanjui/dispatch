# Operational audit and global design — 2026-10-21

Baseline: `159e80b` on `main`. Scope: direct source review, PostgreSQL integration checks, authenticated browser workflows, and failure/retry scenarios. The user requested continued development, global Macro-inspired design, login guidance, and commits/pushes to `main`.

## Findings and changes

| Confirmed behavior                                                                                                                     | Change                                                                                                                                                                                    | Evidence                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Carrier directory hid failed sign-out errors and successful create acknowledgments because feedback rendered only on Loads.            | Share action feedback across the main workspace.                                                                                                                                          | Deterministic Chromium tests reproduce failed sign-out and successful creation while staying in Carriers.                |
| Appointment windows displayed only the start, hiding same-day and overnight end times.                                                 | Show both bounds in the stop's time zone, including dates; equal bounds remain a single appointment.                                                                                      | Browser coverage for same-day and next-day windows.                                                                      |
| List actions had identical accessible names when two carriers shared a reference.                                                      | Include carrier identity on reference and Open buttons.                                                                                                                                   | Browser selects both records unambiguously.                                                                              |
| Login and shared controls retained warm palette/black CTA styles while the shell had its own light/mint palette.                       | Centralize global tokens for typography, white surfaces, neutral text/borders, mint actions, focus, errors and success. Apply to login, dialogs, forms, navigation and operational views. | Production screenshots and contrast token checks; historical static demo remains independent.                            |
| Manual check-ins existed in the demo but not the authenticated app.                                                                    | Add immutable, carrier-scoped manual observations with observation/receipt time, actor, approximate location, note and freshness.                                                         | Eight new database/API tests and four authenticated check-in browser workflows.                                          |
| During implementation, refreshing details after an uncertain check-in save advanced the version and generated a second retry identity. | Preserve original key/version for unchanged observation fields; reset only after a known version conflict.                                                                                | Independently reproduced with different keys/versions before the fix; regression now proves one observation after retry. |
| Frequent observations would leave the activity response unbounded even after limiting check-ins.                                       | Return latest 50 observations and 100 events, disclose truncated history, retain all database records.                                                                                    | Integration test writes 102 observations, verifies returned limits and full persisted history.                           |

## Operational behavior

`POST /api/loads/:id/check-ins` accepts an expected load version, actor-scoped UUID retry key, location (1–160 characters), optional note (up to 1,000) and ISO datetime with offset. Times must be within the last 30 days or no more than five minutes ahead. Source is always `manual`; actor and receipt time come from the server. These are approximate reports, not GPS or live tracking.

Dispatcher/carrier-manager membership controls carrier access. Drivers may report only on currently assigned loads, with a second assignment check after locking. Foreign guessed IDs return 404 and the handler audits denied access. Exact retries still require current access, survive later milestones and do not duplicate event/outbox/audit records. A new observation increments load version without changing milestone state. Delivered loads can still receive reports.

The UI shows observation time separately from recording time and reporter. Reports at least two hours old are marked stale; age labels update every minute. This is an explicit display convention, not an agreed tracking SLA. Late entry sorts by observation time. Local time conversion rejects ambiguous or nonexistent daylight saving times. Failed saves preserve entries; known version conflicts offer detail refresh. A saved report remains acknowledged if detail reload fails and can be recovered through Refresh load details.

Login now explains administrator access and lists fictional QA account choices. The original seeded password is required; no default password is published and reseeding preserves existing password hashes. See README for QA setup. No hosted account availability was inferred from a successful build.

## Verification

- Lint, TypeScript and optimized Next.js build pass.
- **54 tests pass, zero skipped:** 3 prototype smoke, 23 unit/database/API integration, 28 Chromium browser tests. This includes all previous recovery, authority, pagination, carrier isolation and navigation coverage.
- Fresh disposable PostgreSQL database: migrations 001–003 applied from empty, second migration run was a no-op, seed created 3 users/2 carriers/2 loads. Check-in/detail/retry produced exactly one observation/event/outbox/audit entry and preserved stage. Disposable database was removed; existing QA data preserved.
- Local upgrade through migration 003 also passed. Ordinary UPDATE/DELETE of check-ins fails the immutable trigger.
- Runtime dependency audit reports zero vulnerabilities. No dependency versions were changed. Previously recorded development-tool advisories remain outside this runtime-only result.
- Production browser evidence uses real fictional QA data with isolated sessions. Capture details and visual limits are in `design-qa.md`.

## Release and rollback

Run migrations before starting the updated app. Migration 003 adds check-ins without rewriting existing loads or observations; no new environment variable or external service is required. Generic saved environment startup instructions already run the migration runner, which now includes 003. No cloud configuration change or deployment was needed.

Revert the application if needed while retaining migration 003 and its observations. Do not delete the table, immutable history or migration record as an application rollback. Outbox entries remain durable but no delivery worker is enabled. No live messages, carriers, provider tracking or paid services were connected.

## Remaining work and limits

The next operational slice is exception triage/resolution, followed by secure document storage and the two separate financial workflows. Older-history pagination and superseding/correcting a manual report are not implemented. Identity administration, invitations/recovery/MFA, session retention, trusted edge abuse controls and restricted production database roles remain necessary before real operations.

This was a focused direct audit, not a completed managed Codex Security scan: its supporting scan tooling was unavailable in this environment. No exhaustive penetration test, screen-reader certification, Safari/physical-device run or load test is claimed. Local QA passed; GitHub CI and hosted deployment results must be assessed separately.
