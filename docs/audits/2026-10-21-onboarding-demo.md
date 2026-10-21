# Carrier/driver onboarding and demo audit — 2026-10-21

Baseline: `65115b1` on `main`. Scope: the requested carrier/driver onboarding, simpler user flows, darker dashboard text and a public demo matching implemented software. Evidence comes from direct source review, PostgreSQL tests and locally rendered production Chromium workflows. This is not an exhaustive security or accessibility certification.

## Findings and repairs

| Finding | Result |
| --- | --- |
| New carriers and drivers required database provisioning with no guided activation. | Add resumable company → signed agreement → team setup. Private one-use invitations grant the stored carrier/role only; new users choose their own passwords. |
| Driver accounts inherited management navigation and dense operational tables. | Show a focused My loads screen with assigned-load cards, route/status and an action to open details. Server assignment scope still governs every request. |
| Secondary dashboard text was too faint. | Darken global ink, muted and subtle tokens across the workspace, login, dialogs, onboarding and demo; keep the white/mint visual direction. |
| The standalone prototype advertised features absent from the authenticated app. | `/demo` shares the actual workspace and onboarding components with a browser-only fictional adapter. `/demo.html` redirects there; preserve the original separately at `/legacy-demo.html`. |
| Production-speed context refresh could clear a load-dialog error before a user selected recovery. | Background queue refresh no longer clears action errors. Explicit filter changes clear their prior error. Existing version-conflict and saved-but-refresh-failed browser regressions pass against the optimized build. |

## Authorization and persistence

Only a dispatcher with an explicit existing membership in an organization can create a carrier there. New carriers grant only their creator access. Managers can edit their own carrier's company details and invite its drivers; only dispatchers can verify an externally held signed agreement or invite a manager. Identity activation never supplies dispatch authority. Booking and assignment continue to require a current verified agreement.

New drivers remain pending and are excluded from both assignment options and server-side assignment until invitation acceptance. Migration 004 defaults existing drivers to ready for compatibility. A ready account is not a license, regulatory or identity-verification claim.

Invitation tokens are random 32-byte values, stored only as hashes and carried in URL fragments. Inspection/acceptance send tokens in same-origin POST bodies. Expired, revoked and used invitations cannot grant access. Reissue revokes prior pending links; contact changes revoke unused manager invitations for the old address. Existing accounts must authenticate as the invited identity; passwords and conflicting memberships are never silently overwritten.

Carrier locking serializes invite creation/reissue/acceptance; per-email locking serializes account creation. Acceptance atomically creates membership, activates the driver, consumes the invitation and records a session plus append-only event/outbox/audit entries. Create/invite retries retain the same key and token across uncertain responses. Profile edits check versions. No external message or outbox delivery worker is enabled.

## Demo parity and limits

The same React workspace, inspector, create controls, onboarding wizard and join screen render both modes. The sandbox adapter supports existing load creation, assignment, milestones, manual check-ins and onboarding. Role previews, reset and browser persistence are explicit demo controls. Browser tests reject any authenticated `/api/**` request from demo workflows, including invitation acceptance, and verify passwords are not persisted. Demo invitation links work in the same browser only.

Prototype-only exception, document and financial workflows remain historical references until their server implementation exists. The demo does not claim live freight, GPS tracking, email delivery, uploads or payments. Optional phone/USDOT fields are references; no regulator lookup runs.

## Verification

- Lint and TypeScript pass. The Production build hook applies migration 004 and the optimized Next.js build succeeds.
- All 74 tests pass, zero skipped: 3 prototype smoke, 37 unit/database/API and 34 Chromium browser tests. Backend checks cover authorization isolation, retry/expiry/reissue/concurrent acceptance, invitation hashes and membership grants, current-agreement enforcement, immutable history and cookies/origin handling. Browser checks cover the full dispatcher → manager → driver → assignment → check-in journey and failure recovery. Final browser verification runs against the optimized production server.
- Deployment tests apply migrations 001–004 on a fresh disposable database, migrate an older schema, repeat safely, preserve passwords and reject invalid setup. Existing local QA data is retained.
- Six production screenshots cover company, agreement, team, mobile join, mobile driver cards and the current desktop demo. Captures reported no JavaScript page errors or unexpected failed HTTP resources; mobile join/driver checks found no document-wide horizontal overflow. See `design-qa.md` for source references, contrast checks and limitations.

## Operations and rollback

No new environment variables or external services are required. The existing Vercel Production build migration hook includes 004 automatically. Invitation links must be shared privately by the operator; no automatic email/SMS is sent. See [onboarding instructions](../onboarding.md) and [ADR 0006](../decisions/0006-carrier-driver-onboarding.md).

Retain additive schema and immutable history during rollback. Once pending drivers exist, retain ready-only assignment guards or deploy a forward fix; older code would otherwise expose pending drivers for assignment. Future outbox consumers must support the load/onboarding event-source constraint.

Remaining product work includes exceptions, secure documents, separate carrier/dispatcher financial workflows, organization administration, member removal, independent email verification, password recovery/MFA, trusted edge abuse controls and production role separation. No physical-device, Safari, load-test or independent penetration-test result is claimed.
