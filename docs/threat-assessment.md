# Threat assessment — Relay

Date: 2026-10-23. Basis: code on `main` at `82e7ea7`, the 2026-10-20 to 2026-10-23 audits and a local run against fictional data. Method: assets, actors and trust boundaries first, then threats by STRIDE category, each rated by likelihood and impact (L/M/H) given the controls in place. **Verified** means a test or probe in this repository exercises it; **Reviewed** means read in code only; **Assumed** means it depends on deployment or provider behavior nobody has checked here. This is an internal assessment, not a penetration test.

## 1. What is being protected

| Asset                                                                           | Why it matters                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Carrier, driver and dispatcher accounts and sessions                            | Entry to everything below; MFA secrets and recovery codes                            |
| Load, stop, rate and customer data per carrier                                  | Commercial data; cross-carrier leakage is the central tenancy risk                   |
| Carrier compliance documents (insurance, authority, W-9, BOL, POD)              | Identity and business-sensitive; immutable evidence                                  |
| Billing and invoice records, dispatch fees, payment status                      | Financial integrity; fraud target                                                    |
| Written dispatch authorization                                                  | Gate for booking freight; forging it would let loads be booked for the wrong carrier |
| Messages, phone numbers, email addresses                                        | Personal data; queued bodies can hold reset and invitation links                     |
| Audit logs and idempotency records                                              | Evidence and recovery                                                                |
| Platform secrets (`RELAY_DATA_KEY`, `CRON_SECRET`, provider keys, database URL) | Compromise defeats most controls                                                     |
| Availability of dispatch operations                                             | Missed pickups and deliveries are the real-world harm                                |

## 2. Actors

| Actor                                 | Capability assumed                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Anonymous internet user               | Reaches public pages, sign-in, reset, request-access, webhooks                 |
| Credential attacker                   | Leaked passwords, password spraying, phishing for codes                        |
| Malicious or compromised carrier user | Valid session in one carrier; tries foreign IDs, roles above their own         |
| Malicious driver                      | Narrowest role; owns their own check-ins and uploads                           |
| Malicious insider (dispatcher/admin)  | Broad read; tries to change history or hide actions                            |
| Malicious counterparty                | Sends crafted files, emails, SMS and webhook payloads                          |
| Compromised dependency or CI          | Supply-chain code execution at build or run time                               |
| Careless operator                     | Misconfigures production (`APP_ORIGIN`, `RELAY_DATA_KEY`, scanner, seed flags) |

## 3. Trust boundaries and entry points

1. Browser to `/api/*` (single router, cookie session, `Origin` check on writes).
2. Public unauthenticated routes: sign-in, MFA, reset, verification, invitations, access requests, health.
3. Provider webhooks (Twilio SMS and status, Resend status, inbound email): signature-checked, no session.
4. Scheduler (`/api/jobs/notifications`): bearer secret.
5. App to PostgreSQL, object storage (signed URLs), ClamAV, Resend, Twilio, Anthropic, Google and Apple sign-in.
6. Build and deploy: GitHub Actions, Vercel build runs migrations against the production database.
7. AI assistant: model output is untrusted input to the app.

## 4. Threats

Rating is residual risk after current controls (L low, M medium, H high).

### Spoofing

| #   | Threat                                                       | Controls                                                                                                                        | Evidence                              | Risk                                                                                                     |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| S1  | Password guessing or spraying                                | scrypt hashes, per-email 8/min and per-address 60/min limits, address taken from the proxy end of `X-Forwarded-For`             | Verified                              | L                                                                                                        |
| S2  | MFA code guessing after password theft                       | Per-challenge 5, per-account-and-address 10/15 min, account ceiling 30/h, replay-proof TOTP steps                               | Verified                              | L                                                                                                        |
| S3  | Session theft                                                | `HttpOnly`, `SameSite=Strict`, `Secure`, hashed tokens, 12 h or 30 d expiry, revocation on reset and password change, nonce CSP | Reviewed + tests                      | L                                                                                                        |
| S4  | Phishing a password or MFA code                              | MFA optional, not enforced; no device or location alerts; no passkeys                                                           | Reviewed                              | **M**                                                                                                    |
| S5  | Forged webhooks                                              | HMAC checks, timestamp bounds, per-address limit                                                                                | Verified                              | L                                                                                                        |
| S6  | Reset or invitation link poisoning                           | Origin fixed to `APP_ORIGIN` or the platform host in production                                                                 | Verified                              | L (M if `APP_ORIGIN` is unset on a non-Vercel host: Host-based fallback remains outside production only) |
| S7  | Google or Apple sign-in account takeover by unverified email | State cookie, single-use state row, provider checks                                                                             | Reviewed (`oidc.test.ts` covers flow) | L                                                                                                        |

### Tampering

| #   | Threat                                               | Controls                                                                                                          | Evidence                                             | Risk                                                              |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| T1  | CSRF                                                 | `Origin` check, `SameSite=Strict`, JSON bodies                                                                    | Verified                                             | L                                                                 |
| T2  | SQL injection                                        | Parameterised queries throughout                                                                                  | Reviewed (grep found no string-built SQL with input) | L                                                                 |
| T3  | Stored XSS                                           | React escaping, no HTML sinks, script nonce CSP, `nosniff`                                                        | Reviewed                                             | L                                                                 |
| T4  | Malicious upload (macro, polyglot, malware)          | Magic-byte typing (PDF, PNG, JPEG), size limits, ClamAV when configured, downloads as attachment with sandbox CSP | Reviewed; scanner **optional**                       | **M** (H if `RELAY_REQUIRE_MALWARE_SCAN` stays off in production) |
| T5  | Rewriting history or evidence                        | Append-only audit tables, versioned immutable documents, optimistic versions                                      | Verified                                             | L                                                                 |
| T6  | Double submission or replay changing money or status | Idempotency keys end to end                                                                                       | Verified                                             | L                                                                 |
| T7  | CSV formula injection in exports                     | Cell escaping                                                                                                     | Verified                                             | L                                                                 |
| T8  | Money arithmetic errors                              | Integer minor units                                                                                               | Reviewed                                             | L                                                                 |
| T9  | Tampered migration or deploy                         | Production build migrates the live database; no approval gate between merge and migration                         | Reviewed                                             | **M**                                                             |

### Repudiation

| #   | Threat                     | Controls                                                                                                                               | Risk  |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| R1  | A user denies an action    | Audit log for sign-in, role, status, document and export events with actor and time                                                    | L     |
| R2  | An insider hides actions   | Append-only tables; but database administrators and the application role can still alter them, and nothing ships logs off the database | **M** |
| R3  | Disputed external messages | Provider receipts and outbound records; live-provider delivery unverified                                                              | M     |

### Information disclosure

| #   | Threat                                                                           | Controls                                                                                                                                                                            | Evidence                                                         | Risk                                                                                                |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| I1  | Cross-carrier access (IDOR) in handlers, queries, files, exports, jobs, webhooks | Server-side scoping, 403/404 for foreign IDs, export ownership re-check                                                                                                             | Verified (large authorization suite; not re-probed in this pass) | L–M: one missed query in 1,400+ lines of router is the main residual risk                           |
| I2  | Role escalation inside a carrier (driver to manager, dispatcher to admin)        | Role checks per handler                                                                                                                                                             | Verified for tested endpoints                                    | M: no central policy layer, so every new endpoint must remember                                     |
| I3  | Secrets in repository or history                                                 | None found                                                                                                                                                                          | Verified                                                         | L                                                                                                   |
| I4  | Data at rest                                                                     | Queued message bodies and MFA secrets are AES-256-GCM encrypted; **documents, loads and contacts are not encrypted at the application layer** and the key has no rotation procedure | Reviewed                                                         | **M**                                                                                               |
| I5  | Verbose errors                                                                   | Generic codes, request IDs, no stack traces                                                                                                                                         | Reviewed                                                         | L                                                                                                   |
| I6  | User enumeration                                                                 | Constant-time-ish sign-in, uniform reset answer                                                                                                                                     | Verified                                                         | L (access-request and invitation flows may still differ)                                            |
| I7  | Logs                                                                             | Request log has route, status and ID only                                                                                                                                           | Reviewed                                                         | L                                                                                                   |
| I8  | AI assistant leaks other carriers' data                                          | Tools scope by caller; results filtered by allowed carriers                                                                                                                         | Reviewed                                                         | M: prompt injection via document or message text can steer tool calls within the caller's own scope |
| I9  | Referrer or URL leakage                                                          | Tokens in the URL fragment, `strict-origin-when-cross-origin`; MFA challenge is also in a fragment                                                                                  | Reviewed                                                         | L                                                                                                   |

### Denial of service

| #   | Threat                                                                | Controls                                                                           | Risk           |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| D1  | Request floods                                                        | Per-person write budget, public per-address limits; no platform WAF rules reviewed | M              |
| D2  | Expensive paths (scrypt, AI calls, exports, 32 MB inbound email body) | Hash only after limits, AI budget 20/min, export cap 3, body caps                  | L–M            |
| D3  | Account lockout by an attacker                                        | Email-keyed sign-in limit lasts one minute; MFA ceiling up to one hour             | L–M (nuisance) |
| D4  | Database exhaustion                                                   | Pool of 8, statement timeout 10 s; one slow query class can starve it              | M              |
| D5  | Provider outage stalls dispatch communications                        | Outbox, bounded retry, failure visibility; no alerting                             | M              |
| D6  | Stalled jobs                                                          | Stall detection and 30-minute failure for exports; no paging                       | M              |

### Elevation of privilege

| #   | Threat                                                          | Controls                                                                                                                                     | Risk  |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| E1  | Booking freight without verified written authorization          | Enforced in domain logic and tested                                                                                                          | L     |
| E2  | Booked freight moving between carriers                          | Not implicit; guarded                                                                                                                        | L     |
| E3  | Invitation abuse (accept as another email, reuse, expired)      | Email-bound, single-use, expiring, revocable                                                                                                 | L     |
| E4  | AI output acting as authority (booking, rates, invoices, funds) | Human review required by design; assistant has read tools                                                                                    | L     |
| E5  | Supply chain (npm install scripts, GitHub Actions)              | `npm audit` clean, lockfile, CI has no write secrets beyond the scheduler's `CRON_SECRET`; no dependency pinning policy or automated updates | M     |
| E6  | Over-privileged database role                                   | The app connects with one role that can also alter audit tables and run migrations                                                           | **M** |

## 5. Ranked residual risks and what to do

1. **Malware scanning is optional (T4).** Set `RELAY_REQUIRE_MALWARE_SCAN=true` and run ClamAV in production before accepting real carrier files. Without it uploads are stored unscanned.
2. **One database role does everything (E6, R2).** Split a migration role from the runtime role; revoke `UPDATE` and `DELETE` on audit and document-version tables from the runtime role; ship audit events to a write-once log.
3. **Migrations run automatically on merge (T9).** Require a protected branch with review before production deploys, or move migration to a manual approved step; keep the rollback notes current.
4. **No central authorization policy (I1, I2).** Authorization lives in each handler. Add a route-by-role matrix test that enumerates every endpoint and role (including foreign-ID guesses), so a new endpoint without a check fails CI.
5. **Credential phishing (S4).** Enforce MFA for dispatcher, admin and carrier-manager roles; consider passkeys; alert users on new sign-ins.
6. **Data at rest and key management (I4).** Decide whether database-level and bucket encryption suffice; document `RELAY_DATA_KEY` rotation (the ciphertext carries a version prefix, so rotation is feasible but unwritten).
7. **No monitoring or alerting (D5, D6, R3).** Add metrics and alerts for failed notifications, stalled exports, 5xx rates, sign-in failures and 429 spikes.
8. **AI prompt injection (I8).** Treat document and message text as untrusted in prompts, keep tools read-only, and log tool calls with the caller and arguments.
9. **Supply chain (E5).** Turn on automated dependency updates and `npm audit` in CI; pin Actions by commit.
10. **Operator error.** Production start-up should refuse to run without `APP_ORIGIN`, `RELAY_DATA_KEY`, `CRON_SECRET` and a scanner, rather than warn.

## 6. Not assessed

Live providers, a production build behind real infrastructure, Vercel and database account security (SSO, access keys), physical and personnel controls, privacy-law obligations (retention, deletion, consent for tracking and messaging), FMCSA brokerage rules, denial-of-service at network level, and any third-party penetration test. Housekeeping: `undefined/` at the repository root holds tracked screenshots created by a test with an undefined output path; they contain only fictional data but should be removed.
