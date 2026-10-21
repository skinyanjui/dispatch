# 0034 — Account access: keep me signed in, request access, Google and Apple

Status: accepted, 2026-10-22. Touches tenancy (how organizations are created) and authentication.

## Decision

### Keep me signed in (built)
Sign-in has a checkbox, **Keep me signed in for 30 days**. A remembered session lasts 30 days in the database and the `relay_session` cookie carries a 30-day `Max-Age`. A normal session still lasts 12 hours in the database, and its cookie is now a **session cookie** (no `Max-Age`), so it ends with the browser; before this change the cookie persisted for 12 hours. The choice is stored on `sessions.remember` and, for accounts with two-step verification, on `mfa_challenges.remember` so it survives the second factor. The audit log records `session.created.remembered`. Invitation and join flows create ordinary (not remembered) sessions. Migration `028_session_remember.sql` is expand-only; rollback is to leave the columns.

### Terms and Privacy (built)
`/terms` and `/privacy` describe what Relay does today in plain language: what is stored, the one session cookie, who else can see data (organization roles, the AI provider only when an admin enables a feature and only for the request made, email/text providers only if configured, storage providers, Google/Apple only for those who choose them), security and retention. They carry a visible **"Draft, not reviewed by a lawyer"** banner, a version (`src/lib/legal.ts`) and bracketed gaps that only the operator or counsel can fill (legal name, contact, governing law, liability, retention periods, hosting providers). They are not legal advice and make no claim a lawyer has approved them.

### Request access (see later sections)
### Google and Apple sign-in (see later sections)

## Not done
A customer quote on the sign-in hero: there are no customers to quote and inventing one would be a fabricated testimonial. The note "Fictional QA data. No live freight connections." stays instead.
