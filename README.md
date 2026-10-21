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

Integration tests write fictional fixtures to the selected database. Use an isolated QA database, never production. CI creates a fresh PostgreSQL instance, migrates twice to verify repeatability, seeds, and runs all gates. Test fixture passwords are not production credentials.

## Server contracts

- `POST /api/login`, `POST /api/logout`, `GET /api/me`: opaque, hashed server sessions (12-hour expiry). HttpOnly, SameSite Strict cookies; Secure defaults on in production. Local HTTP production-mode testing can explicitly use `COOKIE_SECURE=false`; deployed HTTPS must use true.
- `GET /api/loads?carrier_id=&status=&q=&cursor=`: carrier/assigned-driver scope, 25-record pages.
- `POST /api/loads`: `Idempotency-Key` required; carrierId, reference, source, integer amountMinor and two ordered stops (pickup/delivery), each with address, IANA timezone and ISO-offset windowStart/windowEnd. Verified effective dispatch agreement required.
- `GET /api/loads/:id`: scoped load, stops, assignment, append-only timeline.
- `POST /api/loads/:id/assign`: driverId + expected version; same carrier enforced in app and database.
- `POST /api/loads/:id/milestones`: stage + expected version; booked → dispatched → picked-up → delivered. Assigned driver required. Drivers are read-only in this release.

Writes require a same-origin Origin header. API responses distinguish validation (400), missing session (401), forbidden origin (403), inaccessible/unknown object (404), conflict (409), invalid domain operation (422), throttling (429), and dependency outage (503). Mutation version conflicts require refreshing details before retrying. No carrier transfer operation exists. Carrier-manager and dispatcher can write within explicit memberships. Outbox records are persisted but no external consumer or delivery is enabled.

## Vercel build configuration

The previous static build emitted `dist/`, while Vercel expected `public/`, causing STATIC_BUILD_NO_OUT_DIR. This version uses the **Next.js** framework and `.next` output via `vercel.json`. Set the Vercel project Root Directory to this repository root; clear conflicting build/output overrides in Project Settings. Node is pinned to 22.x to avoid automatic major upgrades.

Before deploying the backend, configure an authenticated PostgreSQL connection as `DATABASE_URL`, run migrations through a controlled release job, and set `COOKIE_SECURE=true` and `APP_ORIGIN` to the canonical HTTPS origin. Do not run fictional seed against production. Builds do not require database access, but login and data operations do. No deployment is performed by these instructions.

## Current limits and next work

This is a reviewable foundation, not a completed production TMS. Stop entry currently supports one pickup and one delivery, and the UI captures appointment instants. Sessions support login/logout; invitations, password reset, MFA and session cleanup are not implemented. Login throttling is process-local and must be replaced with shared throttling before multiple instances. Carrier agreements, users and memberships are provisioned through QA seed only; add audited administrative workflows before real use. Database tenant filtering is application-enforced, with relational assignment constraints; independent security review and database role separation are still needed. Event/audit triggers prevent updates/deletes by ordinary statements, not privileged database administrators. No uploads, exceptions, invoicing, outbox worker, monitoring integration or live tracking is implemented. Queue statistics describe the current loaded page.

See `docs/build-plan.md`, `docs/product-requirements.md`, and `docs/decisions/0002-foundation.md` for design context and remaining phases. Static prototype documentation is retained in `docs/prototype-readme.md`.
