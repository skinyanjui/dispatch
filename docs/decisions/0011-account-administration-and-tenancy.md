# 0011 — Account administration and explicit organization membership

Status: accepted, 2026-10-21.

## Tenancy change

Organizations were previously implied: anyone holding a dispatcher membership on one of an organization's carriers could act for it. `organization_members` (owner/admin) now records organization administrators explicitly.

- Migration 009 backfills every existing dispatcher as `admin` of the organizations of their carriers. The seed makes the QA dispatcher `owner`.
- **Dual-read compatibility:** carrier creation and `/api/me` still accept a carrier dispatcher of the organization as before. This keeps existing deployments and fixtures working. The _contract_ step — require `organization_members` only — follows once all dispatchers have been confirmed as members.
- Organization admins manage the profile (legal name, billing email, phone, address, operating time zone) and may manage the team of every carrier in their organization. Carrier data access is still governed only by carrier `memberships`; organization membership does not by itself expose loads.
- **Bootstrap:** new organizations are created by an operator with `npm run org:create`. There is no public signup. In-app invitations for additional dispatchers/admins are not built yet.

## Account security

- **Password reset.** `POST /api/password-reset/request` always answers 202, so accounts cannot be enumerated, and is limited to 3 per address per minute.
  - The 32-byte token is stored hashed, bound to the email it was sent to, expires in 1 hour, is single-use, and supersedes earlier links.
  - Completing a reset ends every session and pending MFA challenge. It does not disable MFA.
  - The link uses a URL fragment (`/reset-password#token`), so the token never reaches server logs or Referer headers.
- **Email verification.** The link (`/verify-email#token`, 24 hours, single use, bound to the address) sets `email_verified_at`. Accepting an emailed invitation also verifies the address, and migration 009 backfills that. Verification is shown on the account and team views; it does not gate access yet.
- **Change password** requires the current password and signs out other sessions.
- **MFA (TOTP, RFC 6238, SHA-1/6 digits/30 s, ±1 step)**:
  - The secret is sealed with `RELAY_DATA_KEY`. Without the key, enrollment answers `MFA_UNAVAILABLE` (fail closed).
  - Enabling requires a valid code and returns 10 one-time recovery codes, shown once and stored hashed.
  - With MFA on, the password step returns a 5-minute challenge instead of a session. The challenge allows 5 attempts, then it is destroyed.
  - Each TOTP step is accepted at most once (`mfa_last_step`), which blocks replay.
  - Disabling requires the password and a code.
- **Team removal** (`POST /api/carriers/:id/team/remove`):
  - Dispatchers and organization admins can remove managers, drivers and other dispatchers. Carrier managers can remove drivers only.
  - Nobody can remove themselves, and every carrier keeps at least one dispatcher.
  - A driver with undelivered loads must be reassigned first. A removed driver's roster status becomes `removed`, so they can no longer be assigned, and their pending invites are revoked.
  - Open exceptions owned by the removed person return to the unassigned queue, with events.
  - If the person has no remaining access, their sessions are deleted at once. Otherwise access to that carrier ends on the next request, because membership is checked per request.
  - Removals are recorded in append-only `membership_removals` and the carrier event stream.

## Not included

Dispatcher/admin invitations, email change, WebAuthn/passkeys, organization-enforced MFA, session listing/revocation UI, SSO, account deletion and data export. The `drivers.onboarding_status` constraint was widened (not narrowed), so rolling back the app is safe. Removed drivers simply stay unassignable under the old code's `ready`-only predicate.

## Rollback

Revert the application; keep migration 009 (additive, plus a widened check constraint). Users with MFA enabled would be able to sign in with a password alone under older code. Before rolling back past this change, warn users or keep a forward fix.

## Account and notification pages

Presentation only; no API, schema or permission change. The Account page is two aligned columns (profile and password on the left, email and two-step verification on the right) that collapse to one on narrow screens; before, its four cards sat in a ragged row of different widths. The Notifications delivery log is a compact bordered list that shows 20 messages at a time with "Show more"; before, it rendered every message at once (about 5,400px tall on a desktop and 13,000px on a phone with a busy workspace). The Organization page already fit and was left as it is. Playwright now keeps a screenshot of any failing test.

## Organization tabs and link pages

The account page uses the same tab pattern: Profile (name, phone, email) and Security (password, two-step verification), with arrow, Home and End keys. No API or permission change.

Presentation only; no API, schema or permission change. In the Organization People list the person's name, email and role line now share one type scale (the role line was larger than the name). The AI tab's monthly limit is a short field instead of a full-width one. The reset-password, verify-email and invitation-result pages get a heading that fits the card (26px) with room around the small label, the fields and the button; these styles are scoped to a `linkPage` class used only by the reset and verify pages, because the request-access and invitation pages share `joinPage` and have their own form styling (an unscoped rule once made the request-access terms text bold and failed the accessibility scan).
