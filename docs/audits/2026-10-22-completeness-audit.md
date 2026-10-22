# Completeness audit and full-flow test run — 2026-10-22

Baseline: `3c3e19c` on a fresh local PostgreSQL 16 database (migrations 001–034, `npm run db:seed`), production build served with `next start`. Fictional QA data only; no email, SMS, storage, scanner, AI or sign-in provider was reachable or configured.

## What was run

| Check                                                                      | Result                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm run lint`, `npm run typecheck`, `npm run build`                       | pass                                                   |
| `npm test` (static demo check + integration against PostgreSQL)            | **238 / 238** (3 smoke)                                |
| `npx playwright test` (Chromium, production build)                         | **111 / 111** after the fixes below (106 / 111 before) |
| Exploratory sweep: every nav screen as dispatcher, carrier manager, driver | 6 runs (desktop 1440 and phone 390) — see below        |
| HTTP authorization probe against the running server                        | see below                                              |

**Sweep** (axe WCAG 2 A/AA, horizontal overflow, `role=alert` text, console and 5xx errors, per screen): no violations, no overflow, no alerts, no 5xx. The one console error per run is the expected 401 from the signed-out session check.

- Dispatcher sees Loads, Exceptions, Inbox, Contacts, Carriers, Prospects, Assistant, Documents, Billing, Reports.
- Carrier manager sees Loads, Exceptions, Inbox, Contacts, Carriers, Billing, Reports.
- Driver sees Loads, Exceptions, Inbox, Contacts.

**Authorization probe** (anonymous, dispatcher, carrier manager, driver over HTTP, 22 GET and 11 POST routes):

- Anonymous requests get 401 everywhere. `GET /api/jobs/notifications` returns 503 `JOBS_NOT_CONFIGURED` until `CRON_SECRET` is set.
- Dispatcher-only reads (prospects, templates, drafts, assistant) return 404 for carrier and driver sessions. Reports and carrier summary return 404 for drivers.
- Valid-payload writes: carrier `POST /dispatch-invoices` on its own carrier gets 403 `DISPATCHER_REQUIRED`; on a foreign carrier 404. Driver gets 404. Guessed load, billing and carrier-document IDs return 404.
- Writes with a foreign `Origin`, or none, return 403.
- Observation: request bodies are validated before the role check, so an unauthorized user sees field-level validation errors on an invalid body. Nothing is written; it is a minor information leak about payload shape.

## Defects found and fixed in this pass

1. **Invoice with no lines crashed the invoice sheet** (`Cannot read properties of null (reading 'map')`). `json_agg` returns `NULL` when an invoice has no lines. `src/lib/billing.ts` now returns `[]`. The app cannot create such an invoice today, but the contract was inconsistent with the type and with the client search code, which already guarded for it.
2. **Toolbar menus never closed.** The Options menu (and the saved-view menu) floated over the table and ignored outside clicks and Escape, so it covered the Freight column header and blocked sorting until the user clicked its summary again. They now close on an outside click or Escape (Escape returns focus to the menu button). Found because a browser test could not click the header.
3. **Three paging tests depended on accumulated data.** Organization people, carriers and billing each asserted "more than one page" against whatever earlier runs had left in the database, so they failed on a fresh database. `tests/browser/volume.ts` now tops the fictional workspace up idempotently before them.
4. **Carriers test assumed Blue Ridge Transport is always the busiest.** Another test's carrier (27 loads) passes it. The test now asserts the sort order instead.
5. **Assistant test was flaky** (duplicate "Sources" chips from two answers citing the same load; typing before the drawer finished closing). Both fixed in the test.

## What is incomplete

Ordered by how much it blocks real operation. "Documented" means an ADR or earlier audit already says so.

### Blocks live use

- **No live-provider verification (documented).** Object storage, ClamAV, email, SMS, Google and Apple sign-in and AI reading are tested only against in-process fakes. Run one real round trip per provider before enabling `RELAY_REQUIRE_MALWARE_SCAN=true` or relying on notifications.
- **Reminders are daily, not time-based.** `vercel.json` schedules `/api/jobs/notifications` once a day (13:07 UTC). Appointment reminders configured as hours ahead (3–72) can fire hours late or miss short windows. A 15-minute scheduler is needed (documented).
- **No tracking or ETA.** There is no telematics adapter, tracking-observation model or ETA field; the requirement for "source, precision, freshness" on provider observations is met only for manual check-ins. This is correct to state in the UI, but Task 6 integrations are unstarted.
- **Vehicles are schema only.** The `vehicles` table exists in migration 001 but nothing in `src` reads or writes it, so "driver/vehicle authorized by that carrier" is driver-only.
- **No operations-manager role** (a persona in the requirements), no assigned-dispatcher ownership of loads, and no filter by owner or date range on the loads API (`status`, `carrier_id`, `q` only). The calendar uses the loaded set, not a date-range query (documented in ADR 0043).

### Compliance and operations

- **No retention or deletion policy** for documents, messages or audit logs; needs legal review (documented).
- **No metrics, tracing, alerting or health endpoint.** Failures reach `console.error`; there is no dead-letter or reconciliation dashboard for webhooks, outbox or notifications beyond per-row retry (Task 6).
- **No backup or restore procedure, no runbook** for rotating `RELAY_DATA_KEY` beyond "re-enroll MFA". ADRs state rollback as reverting the commit; there are no down-migrations or tested schema rollback, which AGENTS.md asks to be documented.
- **Rate limiting covers the account surface only.** Sign-in, password reset, email verification, MFA, access requests and social-login start/callback are throttled (`consumeAttempt`). Authenticated writes (loads, messages, uploads, assistant questions) and the email/SMS webhooks have no throttle beyond body-size limits and signatures; the assistant and AI reading can incur provider cost, so they need a per-user budget.

### Product gaps

- **Accounts:** no email-address change and no session list or "sign out everywhere" (documented); MFA is optional, not enforceable per organization.
- **Billing:** no invoice PDF or email, accounting export, bank reconciliation, credit notes or accessorials (documented, ADR 0009).
- **Uploads:** not resumable after a failure and capped at 25 MB; the requirement for resumed uploads on poor connections is unmet (documented, ADR 0015).
- **Stops:** no per-stop arrival and departure events as a separate model (documented, ADR 0013). `recordStopEvent` exists; detention and dwell reporting does not.
- **Loads table:** footer aggregations are per visit and not saved in a view; field reordering is not built (ADR 0043).
- **Prospects, CRM:** email and calendar sync and tasks on records remain backlog items; there is no task object (ADRs 0036, 0042).
- **Inbound email:** no provider adapters, and no per-tenant phone numbers (documented).

### Test coverage gaps

- No screen-reader, Safari, Firefox or real-phone run; only Chromium plus axe (automated rules cover roughly a third of WCAG issues).
- No load, concurrency or performance test beyond the cursor and idempotency tests; the billing overview reads document readiness per load and is known not to scale past ~100 rows.
- No migration rollback test; the deployment test migrates an empty database twice, not an upgrade from an older schema with data.
- Browser tests share one database and depend on test order for some state; `ensureVolume` fixes the paging cases only.

## Environment notes for re-running

```
pg_ctlcluster 16 main start
createdb / role relay (superuser, password relay_local), then:
export DATABASE_URL=postgresql://relay:relay_local@127.0.0.1:5432/relay
export SEED_PASSWORD=<12+ chars> RELAY_DATA_KEY=$(openssl rand -base64 32)
export RELAY_EMAIL_TRANSPORT=log RELAY_AI_PROVIDER=fixture
export PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium
npm ci && npm run db:migrate && npm run db:seed && npm run build
npm start &   # then: npm test && npx playwright test
```

This was a focused engineering audit with automated tests and a scripted sweep. It was not a penetration test, a screen-reader certification or a legal review.
