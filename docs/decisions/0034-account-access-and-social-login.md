# 0034 — Account access: keep me signed in, request access, Google and Apple

Status: accepted, 2026-10-22. Touches tenancy (how organizations are created) and authentication.

## Decision

### Keep me signed in (built)
Sign-in has a checkbox, **Keep me signed in for 30 days**. A remembered session lasts 30 days in the database and the `relay_session` cookie carries a 30-day `Max-Age`. A normal session still lasts 12 hours in the database, and its cookie is now a **session cookie** (no `Max-Age`), so it ends with the browser; before this change the cookie persisted for 12 hours. The choice is stored on `sessions.remember` and, for accounts with two-step verification, on `mfa_challenges.remember` so it survives the second factor. The audit log records `session.created.remembered`. Invitation and join flows create ordinary (not remembered) sessions. Migration `028_session_remember.sql` is expand-only; rollback is to leave the columns.

### Terms and Privacy (built)
`/terms` and `/privacy` describe what Relay does today in plain language: what is stored, the one session cookie, who else can see data (organization roles, the AI provider only when an admin enables a feature and only for the request made, email/text providers only if configured, storage providers, Google/Apple only for those who choose them), security and retention. They carry a visible **"Draft, not reviewed by a lawyer"** banner, a version (`src/lib/legal.ts`) and bracketed gaps that only the operator or counsel can fill (legal name, contact, governing law, liability, retention periods, hosting providers). They are not legal advice and make no claim a lawyer has approved them.

### Request access (built)
Sign-up stays invitation-only. `/request-access` (public, same-origin, honeypot, throttled per email and globally) stores an `access_requests` row (migration 029) with the Terms version accepted. It always answers the same way, whether or not an account exists, and sends no email. A request creates no user, tenant or session.

An operator approves with `npm run access:list`, `access:approve -- <id>` or `access:decline -- <id> "reason"`. Approval runs in one transaction: it creates the user (unusable random password) and organization, makes the requester its owner, and issues a 7-day single-use setup link (`password_reset` token). The link is printed for the operator and also queued as an email, which is delivered only if a transport is configured. Repeating an approval returns the same organization and no second link. Approval and decline are audited. An existing account keeps its password.

There is no in-app approval screen: the schema has no platform-administrator role, and adding one is a tenancy decision for a later ADR. Rollback: drop `access_requests`; no other table depends on it.
### Google and Apple sign-in (see later sections)

## Not done
A customer quote on the sign-in hero: there are no customers to quote and inventing one would be a fabricated testimonial. The note "Fictional QA data. No live freight connections." stays instead.
