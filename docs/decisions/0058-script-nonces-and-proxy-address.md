# 0058 Script nonces, proxy-trusted client address, per-address MFA budget

Status: accepted, 2026-10-23.

## Context

The security review (`docs/audits/2026-10-23-security-review.md`) left three accepted risks: the CSP allowed inline scripts, rate limits trusted the first `X-Forwarded-For` entry, and the MFA guess budget was per account only.

## Decision

- `src/proxy.ts` creates a nonce per page request and sets the CSP (`src/lib/csp.ts`); the root layout calls `connection()` so pages render per request, as Next.js requires for nonces. API routes are excluded and set no CSP. `'strict-dynamic'` lets nonced scripts load their chunks.
- `clientIp` uses the `RELAY_PROXY_HOPS`-th entry from the right in production (default 1).
- MFA guesses: 10 per 15 minutes per account and address, 30 per hour per account; a completed email password reset clears the account counter.

## Consequences

Injected markup cannot run script. Public pages cost a render per request (they were small and already `no-store`). Self-hosting behind several proxies must set `RELAY_PROXY_HOPS`. Rollback: restore the CSP header in `next.config.ts` and delete `src/proxy.ts`; the other two changes are independent code.
