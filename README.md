# Relay — Dispatch TMS foundation

Authenticated Next.js / TypeScript dispatch workspace with PostgreSQL persistence. Built from the supplied Relay prototype. **Not production-ready:** this foundation has no live freight integrations, document storage, messaging, or billing implementation. All QA data is fictional.

## Local development

Use Node.js 22 and Docker (or an existing PostgreSQL 17 database).

```sh
npm ci
# Copy .env.example to .env.local, set a local SEED_PASSWORD of at least 12 characters.
docker compose up -d --wait
# CLI scripts read process variables, so export DATABASE_URL and SEED_PASSWORD,
# or use Node's --env-file support as shown below.
node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/seed.ts
npm run dev
```

The authenticated workspace is at port 3000. QA sign-in accounts: `dispatcher@relay.test` (both carriers), `carrier@relay.test` (Blue Ridge only), and `driver@relay.test` (assigned Blue Ridge loads only). All use the password you supplied during first seed. Reseeding preserves existing records and passwords. Never seed a production database. Original interactive demo: `/demo.html`, also `npm run demo` on port 4173. Demo storage is browser-only and independent of backend records.

### Signing in

Use one of the QA emails above with the **original `SEED_PASSWORD` used on first seed**. The login screen's “How do I get access?” lists QA account choices and explains administrator access. There is no public signup, password reset or default shared password. Changing `SEED_PASSWORD` and reseeding does not reset existing passwords. Do not publish your configured password in source control or chat.

A hosted build does not create accounts by default. Configure `DATABASE_URL` and use the Vercel build command below to apply migrations. Initialize a separate fictional QA database only with explicit QA setup. Provision real users through a future audited administration workflow; do not seed a database containing real operations. No hosted login or deployment is implied by local checks.

## Checks

```sh
npm run lint
npm run typecheck
# DATABASE_URL and SEED_PASSWORD must point to a migrated, seeded QA database.
npm test
npm run build
# Start npm run dev or npm start before browser tests.
npx playwright install chromium
# Or use an installed Chromium: PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
npm run test:browser
```

Integration tests write fictional fixtures to the selected database. Use an isolated QA database, never production. Deployment tests also require permission to create/drop disposable databases. CI creates a fresh PostgreSQL instance, migrates twice to verify repeatability, seeds, and runs all gates, including the Production build preparation path. Test fixture passwords are not production credentials.

## Server contracts

- `POST /api/login`, `POST /api/logout`, `GET /api/me`: opaque, hashed server sessions (12-hour expiry). HttpOnly, SameSite Strict cookies; Secure defaults on in production. Local HTTP production-mode testing can explicitly use `COOKIE_SECURE=false`; deployed HTTPS must use true.
- `GET /api/loads?carrier_id=&status=&q=&cursor=`: carrier/assigned-driver scope, 25-record pages with an opaque cursor.
- `POST /api/loads`: `Idempotency-Key` required; carrierId, reference, source, integer amountMinor and two ordered stops (pickup/delivery), each with address, IANA timezone and ISO-offset windowStart/windowEnd. Verified effective dispatch agreement required.
- `GET /api/loads/:id`: scoped load, stops, assignment, latest 50 check-ins by observation time, and latest 100 activity events (chronological within that window). `events_truncated` explicitly marks omitted older events; all history remains stored.
- `POST /api/loads/:id/assign`: driverId + expected version; same carrier enforced in app and database.
- `POST /api/loads/:id/milestones`: stage + expected version; booked → dispatched → picked-up → delivered. Assigned driver required. Drivers cannot assign or change milestones.
- `POST /api/loads/:id/check-ins`: `{version, location, note?, observed_at, idempotency_key}`. Location is 1–160 characters, note up to 1,000, time is an ISO datetime with offset from the last 30 days through five minutes ahead, and key is a UUID. Authenticated dispatchers/managers may record within their carrier scope; drivers may record only on currently assigned loads. Source is always `manual`; actor and receipt time come from the server. Retries retain the original payload, version and key. Observations increment version and append event/outbox/audit records without changing the shipment milestone.

Writes require a same-origin Origin header. API responses distinguish validation (400), missing session (401), forbidden origin (403), inaccessible/unknown object (404), conflict (409), invalid domain operation (422), throttling (429), and dependency outage (503). Mutation version conflicts require refreshing details before retrying. No carrier transfer operation exists. Carrier-manager and dispatcher can write within explicit memberships. Outbox records are persisted but no external consumer or delivery is enabled.

## Vercel build configuration

The previous static build emitted `dist/`, while Vercel expected `public/`, causing STATIC_BUILD_NO_OUT_DIR. This version uses the **Next.js** framework and `.next` output via `vercel.json`. Set the Vercel project Root Directory to this repository root; clear conflicting build/output overrides in Project Settings. Node is pinned to 22.x to avoid automatic major upgrades.

`vercel.json` installs build tools with `npm ci --include=dev` and runs **`npm run build:vercel`**. When Vercel sets `VERCEL_ENV=production`, this applies all pending migrations before compiling Next.js. Missing `DATABASE_URL` or failed migrations stop the build instead of releasing an app that cannot log in. Existing migrations are skipped under the database advisory lock. Preview/local builds skip database preparation, preventing a preview from changing a shared Production database. `npm run build` remains a database-independent compile for local use. Existing additive migrations can coexist with the previous app while a build runs; future incompatible schema changes still require a reviewed release plan.

In **Vercel → dispatch → Settings → Environment Variables → Production**, configure `DATABASE_URL`, `APP_ORIGIN=https://dispatch-nine-pearl.vercel.app` (or your canonical origin), and `COOKIE_SECURE=true`. Redeploy after changing variables; running deployments do not pick up new values automatically. Successful build logs include `Migrations current` and `Production database preparation complete.` If an override still runs `npm run build`, change it to `npm run build:vercel` or clear it to use `vercel.json`.

### Initialize the hosted fictional QA accounts

For a dedicated QA database only, also add these **Production environment** variables in Vercel before redeploying:

| Key | Value |
| --- | --- |
| `RELAY_QA_SEED` | `true` |
| `SEED_PASSWORD` | Your chosen private QA password, at least 12 characters |

The build then initializes the three QA logins and fictional carrier/load fixtures. Sign in as `dispatcher@relay.test` using that chosen password; the local workspace's password is not automatically copied to Vercel. Existing users, data and password hashes are preserved on repeat builds. You may remove `RELAY_QA_SEED` after initialization. Setting `SEED_PASSWORD` alone never creates accounts or resets passwords. Do not put either password or connection-string values in source control or chat. A Vercel environment named Production may host this fictional QA app; explicit QA setup must not target a database with real operations.

**Login troubleshooting:** `relation "login_attempts" does not exist` means the database is reachable but migrations have not created the authentication table. Deploy the current code through `build:vercel` to apply migrations 001–003. `ECONNREFUSED 127.0.0.1:5432` on Vercel means the database configuration is missing or incorrectly points at localhost. `INVALID_CREDENTIALS` after successful migrations means the account/password is absent or different; initialize QA accounts as above or use the original seeded password. Never remove shared throttling or create tables inside login requests to bypass setup.

## Workspace and audit

The light workspace adapts the user-supplied Macro references: a narrow icon rail, a contextual Dispatch sidebar, stage queues, carrier scope, and Board/List views with a slide-over load inspector. Global design tokens give login, forms, dialogs, notifications and workspace views the same typography, white surfaces, mint actions and focus states. The carrier directory shows your current memberships and roles, supports search, and opens scoped loads. Collapse the sidebar for more room; on narrow screens, Open navigation brings up a drawer. Views share server-backed records; cards do not drag loads into a new status. Use Filter for carrier/milestone scope and Command/Ctrl+K to focus search. Counters reflect the records currently shown. Session expiry clears the workspace and returns to sign-in. Retrying a failed create preserves the idempotency key for unchanged entries.

Open a load and choose **Add check-in** to record an approximate location, observed local time/zone and optional handoff note. The inspector separates observation and recording times and names the reporter. Reports older than two hours are labeled stale; age labels update every minute. This is a visible freshness convention, not an operational SLA or live tracking. Earlier observations entered later do not displace a newer observation. History is immutable; editing/correction and older-history pagination remain future work.

See the [operational audit and global design evidence](docs/audits/2026-10-21-operational-audit.md), [previous follow-up audit](docs/audits/2026-10-20-follow-up-audit.md), [initial application audit](docs/audits/2026-10-20-application-audit.md), and [visual QA](design-qa.md). Migration 002 adds shared login-attempt storage; **003 adds immutable check-ins. Run `npm run db:migrate` with the QA database environment before starting this version.** Assignment requires a current verified carrier dispatch agreement. Existing idempotency retries remain valid after an agreement expires because they do not create or assign new freight.

Changes are committed on `main` after relevant checks and pushed to `origin/main`, preserving remote history. This project preference is recorded in `AGENTS.md`.

## Current limits and next work

This is a reviewable foundation, not a completed production TMS. Stop entry currently supports one pickup and one delivery. Enter appointments in each stop’s selected local time zone; ambiguous or nonexistent daylight saving times are rejected. Rates are entered in dollars and converted to integer cents without floating point. Sessions support login/logout; invitations, password reset, MFA and session cleanup are not implemented. Login throttling is shared through PostgreSQL (eight attempts per identity per minute); add trusted edge/IP controls to limit distributed abuse and account lockout before public rollout. Carrier agreements, users and memberships are provisioned through QA seed only; add audited administrative workflows before real use. Database tenant filtering is application-enforced, with relational assignment constraints; independent security review and database role separation are still needed. Event/audit triggers prevent updates/deletes by ordinary statements, not privileged database administrators. No uploads, exceptions, invoicing, outbox worker, monitoring integration or live tracking is implemented. Queue statistics describe the current loaded page.

See `docs/build-plan.md`, `docs/product-requirements.md`, and `docs/decisions/0002-foundation.md` for design context and remaining phases. Static prototype documentation is retained in `docs/prototype-readme.md`.
