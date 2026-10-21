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

The authenticated workspace is at port 3000. QA sign-in accounts: `dispatcher@relay.test` (both carriers), `carrier@relay.test` (Blue Ridge only), and `driver@relay.test` (assigned Blue Ridge loads only). All use the password you supplied during first seed. Reseeding preserves existing records and passwords. Never seed a production database. The current interactive demo is `/demo` (`/demo.html` redirects there). It uses the same application screens with browser-only fictional data. The historical prototype remains at `/legacy-demo.html`; `npm run demo` still serves that historical prototype on port 4173.

### Signing in

Use one of the QA emails above with the **original `SEED_PASSWORD` used on first seed**. The login screen's “How do I get access?” lists QA account choices and explains administrator access. There is no open signup or default shared password. People ask for access at `/request-access`; an operator approves with `npm run access:list` / `access:approve -- <id>` / `access:decline -- <id> "reason"`, which prints a private link to set the password. Changing `SEED_PASSWORD` and reseeding does not reset existing passwords. Do not publish your configured password in source control or chat.

A hosted build does not create accounts by default. Configure `DATABASE_URL` and use the Vercel build command below to apply migrations. Initialize a separate fictional QA database only with explicit QA setup. Carrier managers and drivers can now activate through private, carrier-scoped invitations. Initial dispatcher/organization administration still requires controlled provisioning. Do not seed a database containing real operations. No hosted login or deployment is implied by local checks.

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

Operations, finance and account contracts added in migrations 005–009 (see the ADRs for rules):

- History: `GET /api/loads/:id/events?before=` and `GET /api/loads/:id/check-ins?before=` page backwards using `events_cursor`/`check_ins_cursor` from load detail; `POST /api/loads/:id/check-ins/:checkInId/amend` `{action: correct|retract, version, reason, idempotency_key, …}`. Loads accept 2–10 stops.
- Documents: `POST /api/documents` (multipart: `carrier_id`, `load_id?`, `type`, `expires_on?` for insurance, `idempotency_key`, `file` ≤ 4 MiB PDF/PNG/JPEG); larger files (≤ 25 MiB, bucket required): `POST /api/documents/uploads` (document fields + `filename`, `size_bytes`, `sha256`) → presigned `upload_url`, then `POST /api/documents/uploads/:id/finalize`; `GET /api/documents/:versionId/content`; `POST /api/documents/:versionId/review` `{decision, note?}` (dispatcher); `GET /api/carriers/:id/documents`. Load detail includes `documents`. [ADR 0007](docs/decisions/0007-documents-and-compliance.md)
- Exceptions: `POST /api/loads/:id/exceptions`; `POST /api/exceptions/:id` `{action: assign|start|resolve|reopen, version, …}`; `GET /api/exceptions?status=&owner=&overdue=`. Load detail includes `exceptions`, `exception_suggestions`, `exception_owners`. [ADR 0008](docs/decisions/0008-exception-management.md)
- Billing: `GET /api/billing?carrier_id=`; `POST /api/loads/:id/billing-packet` (`/submit`, `/receipts`); `POST /api/dispatch-invoices`, `POST /api/dispatch-invoices/:id` `{action: issue|void}`, `POST /api/dispatch-invoices/:id/payments`. [ADR 0009](docs/decisions/0009-separate-billing-lifecycles.md)
- Notifications: `GET /api/notifications` (dispatcher delivery log), `POST /api/notifications/:id/retry`, `GET|POST /api/notifications/preferences`, `GET /api/jobs/notifications` (Bearer `CRON_SECRET`). [ADR 0010](docs/decisions/0010-notification-delivery.md)
- Account: `POST /api/login` may return `{mfa_required, challenge}` → `POST /api/login/mfa`; `POST /api/password-reset/request|complete`; `GET /api/account`; `POST /api/account/password`, `/verify-email/request`, `/verify-email/complete`, `/mfa/setup|enable|disable`; `GET /api/organizations/:id`, `POST /api/organizations/:id/profile`; `POST /api/carriers/:id/team/remove`. [ADR 0011](docs/decisions/0011-account-administration-and-tenancy.md)

Writes require a same-origin Origin header. API responses distinguish validation (400), missing session (401), forbidden origin (403), inaccessible/unknown object (404), conflict (409), invalid domain operation (422), throttling (429), and dependency outage (503). Mutation version conflicts require refreshing details before retrying. No carrier transfer operation exists. Carrier-manager and dispatcher can write within explicit memberships. Load/onboarding outbox records are persisted but no external consumer is enabled; email notifications use their own delivery outbox (ADR 0010).

## Vercel build configuration

The previous static build emitted `dist/`, while Vercel expected `public/`, causing STATIC_BUILD_NO_OUT_DIR. This version uses the **Next.js** framework and `.next` output via `vercel.json`. Set the Vercel project Root Directory to this repository root; clear conflicting build/output overrides in Project Settings. Node is pinned to 22.x to avoid automatic major upgrades.

`vercel.json` installs build tools with `npm ci --include=dev` and runs **`npm run build:vercel`**. When Vercel sets `VERCEL_ENV=production`, this applies all pending migrations before compiling Next.js. Missing `DATABASE_URL` or failed migrations stop the build instead of releasing an app that cannot log in. Existing migrations are skipped under the database advisory lock. Preview/local builds skip database preparation, preventing a preview from changing a shared Production database. `npm run build` remains a database-independent compile for local use. Existing additive migrations can coexist with the previous app while a build runs; future incompatible schema changes still require a reviewed release plan.

In **Vercel → dispatch → Settings → Environment Variables → Production**, configure `DATABASE_URL`, `APP_ORIGIN=https://dispatch-nine-pearl.vercel.app` (or your canonical origin), and `COOKIE_SECURE=true`. Redeploy after changing variables; running deployments do not pick up new values automatically. Successful build logs include `Migrations current` and `Production database preparation complete.` If an override still runs `npm run build`, change it to `npm run build:vercel` or clear it to use `vercel.json`.

### Initialize the hosted fictional QA accounts

For a dedicated QA database only, also add these **Production environment** variables in Vercel before redeploying:

| Key             | Value                                                   |
| --------------- | ------------------------------------------------------- |
| `RELAY_QA_SEED` | `true`                                                  |
| `SEED_PASSWORD` | Your chosen private QA password, at least 12 characters |

The build then initializes the three QA logins and fictional carrier/load fixtures. Sign in as `dispatcher@relay.test` using that chosen password; the local workspace's password is not automatically copied to Vercel. Existing users, data and password hashes are preserved on repeat builds. You may remove `RELAY_QA_SEED` after initialization. Setting `SEED_PASSWORD` alone never creates accounts or resets passwords. Do not put either password or connection-string values in source control or chat. A Vercel environment named Production may host this fictional QA app; explicit QA setup must not target a database with real operations.

**Login troubleshooting:** `relation "login_attempts" does not exist` means the database is reachable but migrations have not created the authentication table. Deploy the current code through `build:vercel` to apply migrations 001–004. `ECONNREFUSED 127.0.0.1:5432` on Vercel means the database configuration is missing or incorrectly points at localhost. `INVALID_CREDENTIALS` after successful migrations means the account/password is absent or different; initialize QA accounts as above or use the original seeded password. Never remove shared throttling or create tables inside login requests to bypass setup.

## Guided onboarding and matching demo

**Load changes and reports.** Dispatchers and carrier managers can correct a load or cancel it before pickup, with a reason, a change history and a notice to the assigned driver, and safe retries after a lost response ([ADR 0019](docs/decisions/0019-load-edit-and-cancel.md), [ADR 0026](docs/decisions/0026-load-change-idempotency-and-cancellation-effects.md)). Drivers get appointment reminders ([ADR 0020](docs/decisions/0020-appointment-reminders.md)). **Read with AI** (off by default) lets an organization admin allow Claude to read insurance certificates, rate confirmations, BOLs and PODs and suggest values for a person to check; it never changes a record ([ADR 0028](docs/decisions/0028-ai-document-reading.md)). **Reports** shows loads, on-time rate, exceptions and billing with a CSV export ([ADR 0024](docs/decisions/0024-reporting.md)).

**Sign-in.** _Keep me signed in for 30 days_ keeps a session for 30 days on that device; without it the session cookie ends with the browser (12-hour limit either way). **Google and Apple** buttons appear only after the operator sets the credentials listed in `.env.example`; signing in with them never creates an account, it links an existing one by verified email or records an access request. [Terms](/terms) and [Privacy](/privacy) pages describe how Relay works today and are drafts that need legal review ([ADR 0034](docs/decisions/0034-account-access-and-social-login.md)).

**Rate confirmation to draft load.** In _New load_, _Fill from a rate confirmation_ reads the broker's file and fills the form (reference, broker, rate, stops and appointment times) with the things to check marked. A person reviews and creates the load as usual; a carrier still needs a verified dispatch agreement, and the original file is attached as the load's rate confirmation, pending review. It needs AI document reading turned on and shares the monthly AI limit ([ADR 0032](docs/decisions/0032-rate-confirmation-to-draft-load.md)).

**Assistant.** _Assistant_ is a chat for staff over their own loads, exceptions, billing, prospects, contacts and carriers. It can only read: it cannot book, change, invoice, message or move money, and each answer lists the records it used. It is off until an owner or admin turns it on (Organization → AI), it needs a model account on the server, and it shares the monthly AI limit ([ADR 0031](docs/decisions/0031-dispatch-assistant.md)).

**Prospects.** _Prospects_ is a board for carriers you are courting (New, Contacted, Qualified, Agreement sent, Won, Lost) with an owner, a next follow-up date and a history of calls and notes. Only your organization's staff can see it. _Start carrier setup_ creates the carrier record only; booking freight still needs a verified, written dispatch agreement, and nothing in Prospects sends messages ([ADR 0030](docs/decisions/0030-prospects.md)).

**Contacts and Inbox.** _Contacts_ is one searchable list of your team, drivers, carriers, brokers and shippers with call/text/email shortcuts and favorites ([ADR 0017](docs/decisions/0017-contacts-directory.md)). _Inbox_ keeps conversations: Relay messages, emails sent from Relay, texts to people who agreed to them, and calls or outside emails you log by hand, plus reusable saved replies ([ADR 0018](docs/decisions/0018-inbox-and-messaging.md)). Relay does not read your mailbox or phone: replies from outside appear automatically only when inbound email/text webhooks are configured ([ADR 0023](docs/decisions/0023-inbound-email-and-text.md)); otherwise log them by hand. Nothing is emailed or texted unless a transport is configured (`RELAY_EMAIL_TRANSPORT`, `RELAY_SMS_TRANSPORT=twilio`). Dispatcher and admin invitations are in **Organization** ([ADR 0016](docs/decisions/0016-staff-invitations.md)).

Open **Carriers → Add carrier** as a dispatcher. Save company contact, record signed dispatch-agreement review, and invite the team in three focused steps. Carrier managers can add drivers for their own carrier. Private one-use links let each person choose their own password. An invitation email is queued automatically when email delivery is configured (`RELAY_DATA_KEY` plus `RELAY_EMAIL_TRANSPORT`); the copyable link remains as a fallback. Agreement review now uploads and links the signed agreement file. Drivers become assignable after joining and land on a focused **My loads** view. Existing account passwords are preserved. See [onboarding guide and API contracts](docs/onboarding.md) and [ADR0006](docs/decisions/0006-carrier-driver-onboarding.md).

The current `/demo` shares these real React components with an isolated fictional adapter; it makes no authenticated API calls or external service connections. It demonstrates the implemented workflows, including documents (file metadata only — contents are not retained), exceptions, billing and notification preferences. Account security needs real accounts, so the demo says so instead of simulating it. Dashboard text and supporting labels now use darker global tokens. See the [onboarding and demo audit](docs/audits/2026-10-21-onboarding-demo.md) for verification and limits.

## Workspace and audit

The light workspace uses a single Claude-inspired sidebar: New load and Search, then each page exactly once (Loads, Exceptions, Carriers, Billing), with stage queues and carrier scope shown only under Loads, and Account, Organization, Notifications, the demo and Sign out in the account menu. Collapsing keeps the same items as 16px icons; nothing is duplicated in a separate rail. Board/List views open a slide-over load inspector. Components use a compact density layer (`src/app/density.css`: 11px minimum text, 400/500/600 weights). Global design tokens give login, forms, dialogs, notifications and workspace views the same typography, white surfaces, mint actions and focus states. The carrier directory shows your current memberships and roles, supports search, and opens scoped loads. Collapse the sidebar for more room; on narrow screens, Open navigation brings up a drawer. Views share server-backed records; cards do not drag loads into a new status. Use Filter for carrier/milestone scope and Command/Ctrl+K to focus search. Counters reflect the records currently shown. Session expiry clears the workspace and returns to sign-in. Retrying a failed create preserves the idempotency key for unchanged entries.

Open a load and choose **Add check-in** to record an approximate location, observed local time/zone and optional handoff note. The inspector separates observation and recording times and names the reporter. Reports older than two hours are labeled stale; age labels update every minute. This is a visible freshness convention, not an operational SLA or live tracking. Earlier observations entered later do not displace a newer observation. History is immutable; editing/correction and older-history pagination remain future work.

See the [operational audit and global design evidence](docs/audits/2026-10-21-operational-audit.md), [previous follow-up audit](docs/audits/2026-10-20-follow-up-audit.md), [initial application audit](docs/audits/2026-10-20-application-audit.md), and [visual QA](design-qa.md). Migration 002 adds shared login-attempt storage; **003 adds immutable check-ins; 004 adds guided onboarding and private invitations; 005 documents; 006 exceptions; 007 billing; 008 notifications; 009 account security and organization admins; 010 document object storage and scan log; 011 check-in amendments; 012 stop arrival/departure events; 013 direct upload sessions. Run `npm run db:migrate` with the QA database environment before starting this version.** Assignment requires a current verified carrier dispatch agreement. Existing idempotency retries remain valid after an agreement expires because they do not create or assign new freight.

Changes are committed on `main` after relevant checks and pushed to `origin/main`, preserving remote history. This project preference is recorded in `AGENTS.md`.

## Current limits and next work

This is a reviewable foundation, not a completed production TMS. Loads support 2–10 ordered stops (first a pickup, last a delivery); milestones remain load-level ([ADR 0013](docs/decisions/0013-multi-stop-and-check-in-history.md)). Check-ins can be corrected or retracted with a reason, keeping the original on record, and older activity and check-ins load on demand. Enter appointments in each stop’s selected local time zone; ambiguous or nonexistent daylight saving times are rejected. Rates are entered in dollars and converted to integer cents without floating point. Password reset, email verification, TOTP MFA, team removal and organization profiles are implemented; dispatcher/admin invitations, email change, enforced MFA and session-management UI are not. Documents can be stored in an S3-compatible bucket and scanned by ClamAV before storage ([ADR 0012](docs/decisions/0012-object-storage-and-malware-scanning.md)); with a bucket, files from 4 MB to 25 MB upload directly to it and are verified and scanned before they become documents ([ADR 0015](docs/decisions/0015-direct-to-bucket-uploads.md), which also lists the bucket CORS and lifecycle settings it needs); all are off until configured (`RELAY_DOCUMENT_STORE`, `RELAY_MALWARE_SCANNER`, `RELAY_REQUIRE_MALWARE_SCAN`). Move existing files with `npm run documents:migrate-storage`. No email is sent until a transport is configured. Login throttling is shared through PostgreSQL (eight attempts per identity per minute); add trusted edge/IP controls to limit distributed abuse and account lockout before public rollout. Dispatchers can onboard carriers in their existing organization and record signed-agreement review; carrier managers and drivers activate through invitations. Create a new organization with `ORG_NAME=… OWNER_EMAIL=… OWNER_NAME=… OWNER_PASSWORD=… npm run org:create`. Regulator checks remain future work. Database tenant filtering is application-enforced, with relational assignment constraints; independent security review and database role separation are still needed. Event/audit triggers prevent updates/deletes by ordinary statements, not privileged database administrators. No monitoring integration, accounting export, invoice PDF/email, SMS or live tracking is implemented. See the [documents, exceptions, billing, accounts and notifications audit](docs/audits/2026-10-21-operations-finance-accounts.md). Queue statistics describe the current loaded page.

See `docs/build-plan.md`, `docs/product-requirements.md`, and `docs/decisions/0002-foundation.md` for design context and remaining phases. Static prototype documentation is retained in `docs/prototype-readme.md`.
