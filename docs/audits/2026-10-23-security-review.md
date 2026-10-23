# Security review — 2026-10-23

Scope: the code on `main` (`3330bca`), read and probed locally against fictional data. `npm audit`: 0 vulnerabilities. No secrets in tracked files or history (the only matches are the AWS documentation example key in test fakes). No live provider, storage or sign-in service was reachable.

## Checked and sound

- **Headers:** CSP (no framing, no objects, `unsafe-eval` only in development), HSTS, `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policy on every route; API replies are `private, no-store`.
- **Session cookie:** `HttpOnly`, `SameSite=Strict`, `Secure` in production; token is 256 random bits, only its SHA-256 is stored; a password reset ends every session; a password change ends the others.
- **CSRF:** every browser write checks `Origin`; provider webhooks verify their own signatures (Twilio HMAC, Svix timestamp and ID, inbound MAC) with constant-time compares.
- **Injection:** all queries are parameterised (no string-built SQL with user input); no `dangerouslySetInnerHTML`, `eval` or user-driven redirects; the only server-side fetches go to fixed provider hosts (Twilio media is restricted to the configured Twilio origin).
- **Files:** content is identified by magic bytes, not the supplied type or name; downloads are `attachment`, `nosniff`, with `Content-Security-Policy: sandbox`; storage keys are server-generated.
- **Enumeration:** sign-in does the password hash even for unknown users; reset always answers 202.

## Defects found and fixed

1. **Reset and invitation links could point at an attacker's site (high when `APP_ORIGIN` is unset).** Links in email used the request's `Origin`, and the same-origin check compares `Origin` with the request's own `Host`; a script sending a matching forged pair to the public `password-reset/request` endpoint got a reset link for the victim's address on the attacker's domain. In production the link origin now comes only from `APP_ORIGIN`, or the platform's own Vercel host; the request is used only outside production. (`notifications.ts`)
2. **Second factor could be brute-forced with a known password (high).** The limit was five guesses per challenge, but a correct password issues a new challenge and clears the sign-in counter, so only the 60/minute address limit applied: roughly 300 guesses a minute against a six-digit code. Guesses are now budgeted per account: 10 per 15 minutes across all challenges. (`account.ts`, `consumeAttempt` takes an optional window)
3. **Unauthenticated endpoints had no per-address limit (medium).** Password reset request (mail to any existing address), reset completion (runs a password hash before checking the token, so cheap CPU load), email verification, invitation inspect/accept and access requests are now limited to 40 a minute per address; the webhook endpoints, one of which reads up to 32 MB before it can verify, to 300. (`route.ts`)

Tests: `tests/integration/security-hardening.test.ts` (each fails without its fix).

## Follow-up: the three accepted items, now fixed

1. **Spoofable client address.** In production the address is the entry `RELAY_PROXY_HOPS` from the right of `X-Forwarded-For` (default 1), which a client cannot forge because each proxy appends its own view. Set `RELAY_PROXY_HOPS` when more than one proxy sits in front. Outside production the first entry is used so tests can pose as different callers.
2. **Inline scripts in the CSP.** Pages now render per request with a fresh nonce from `src/proxy.ts`; `script-src` is `'self' 'nonce-…' 'strict-dynamic'` with no `'unsafe-inline'`, and `form-action 'self'` is added. Styles keep `'unsafe-inline'` because components set style attributes; that allows styling tricks but not script execution. Cost: marketing and sign-in pages are no longer prerendered (ADR 0058).
3. **MFA lockout.** The guess budget is 10 per 15 minutes per account and address, so an attacker elsewhere cannot spend the owner's allowance. Guessing spread over many addresses is stopped by an account ceiling of 30 an hour, and completing a password reset by email lifts that ceiling for the owner. An attacker who spreads guesses can still block the owner for up to an hour until they reset the password.

## Open / accepted

- **Style attributes** still need `'unsafe-inline'` in `style-src`.
- **Ceiling lockout:** see 3 above; password reset by email is the recovery path.
- **Not tested here:** live provider behaviour, a production build behind a real proxy chain, and a third-party penetration test. Cross-carrier isolation was not re-probed; it is covered by the existing authorization tests and the 2026-10-20 to 2026-10-22 audits.
