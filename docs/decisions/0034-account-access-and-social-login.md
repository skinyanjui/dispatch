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

### Google and Apple sign-in (built, off until configured)

OpenID Connect authorization code flow with PKCE (`src/lib/oidc.ts`, `node:crypto` only). It is off until the operator sets `GOOGLE_CLIENT_ID/SECRET` or `APPLE_CLIENT_ID/TEAM_ID/KEY_ID/PRIVATE_KEY`; `GET /api/auth/providers` returns booleans only and the sign-in buttons render only for configured providers. Register `/api/auth/oidc/google/callback` and `/api/auth/oidc/apple/callback` with the providers.

- `start` stores state, nonce and the PKCE verifier in `oidc_states` (10 minutes) and puts the random state in an HttpOnly cookie. The callback requires the cookie to equal the returned state (so a victim cannot be fed an attacker's code) and deletes the row (so it works once).
- The ID token is verified: RS256 signature against the provider's JWKS, issuer, audience, expiry, nonce and subject. The email must be `email_verified`.
- Outcomes: a known `(provider, subject)` signs in; a verified email matching an existing account links the identity (audited `auth.identity_linked`) and signs in; an unknown verified email creates only an **access request** (an operator still decides); anything else shows a retryable message and creates nothing. Accounts with two-step verification still receive an MFA challenge, not a session; "keep me signed in" carries through. The challenge returns to the page in the URL fragment, which the page removes from the address bar.
- Apple returns by `form_post`, a cross-site POST that cannot pass the same-origin check or carry a Strict/Lax cookie. Only that callback is exempt from the origin check; the state cookie (`SameSite=None; Secure` in production) and the single-use state row authenticate it. Apple's client secret is an ES256 JWT (10-minute lifetime) signed from the configured key.
- Rollback: unset the credentials to hide the buttons and refuse the routes; `external_identities` and `oidc_states` can stay unused.
- Verification: covered with a stubbed provider (own RSA keys, JWKS and token endpoint). It has not been run against live Google or Apple, which needs credentials and registered redirect URLs; do that once before relying on it.

## Not done

A customer quote on the sign-in hero: there are no customers to quote and inventing one would be a fabricated testimonial. The note "Fictional QA data. No live freight connections." stays instead.

Also not done: an in-app screen for approving requests (needs a platform-administrator role, which is a tenancy decision for a later ADR); CAPTCHA and email-domain rules (honeypot and throttling only); legal review of Terms and Privacy; live testing against Google and Apple.

## Terms and Privacy pages

Presentation only; the legal text, version and "not reviewed by a lawyer" notice are unchanged. The pages now use the site's top bar, breadcrumb and footer (they were a separate pale page with only Terms and Privacy links), the text sits in a column of about 70 characters, and each page has an "On this page" list built from its headings, which now have stable anchors. On wide screens the list is sticky beside the text; on phones it is a wrapping row of links above it. "Back to sign in" is still at the end, and the sign-in and request-access forms still link here.
