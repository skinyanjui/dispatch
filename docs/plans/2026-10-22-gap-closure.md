# Plan: close the five gaps from the completeness audit

Date: 2026-10-22. Branch base: `main` at `4c6166c`. Fictional QA data only; nothing is deployed, no provider is connected and no cost is incurred.

## Items, in build order (one atomic commit each, tests included)

| #   | Item                                                            | Why this order                                                   |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Error and 404 pages                                             | Smallest; the URL work below needs a real 404 for unknown paths. |
| 2   | Own URL for every load, invoice and carrier (and every section) | Later pages register their paths in the same table.              |
| 3   | Sub-hourly scheduler                                            | Adds `job_runs`, which the audit page shows.                     |
| 4   | Audit log page                                                  | Needs `job_runs` for its scheduler panel.                        |
| 5   | Fleet page: drivers and vehicles                                | Largest; last so earlier commits are small and reviewable.       |

## Trace for each item (AGENTS.md: intent → UX → contract → authorization → domain → DB → events → observability and recovery)

### 1. Error and 404 pages

- **UX:** `not-found.tsx` (unknown address, unknown load id shape), `error.tsx` (a page failed; Try again, Go to Loads), `global-error.tsx` (the layout failed). Plain language, one primary action, `role="alert"` on errors, no stack traces or ids shown. Same look as the sign-in pages.
- **Authorization:** the 404 for a record the person cannot see is identical to the 404 for one that does not exist (no existence leak).
- **Observability:** `error.tsx` logs `ui.error` with the digest only.
- **Tests:** browser (unknown path → 404 page with a link home; axe clean), unit for the digest-only logging helper.

### 2. URLs

- **Scheme:** `/` Loads, `/loads/:id`, `/carriers`, `/carriers/:id` (opens that carrier's setup), `/billing`, `/billing/invoices/:id`, `/exceptions`, `/inbox`, `/contacts`, `/prospects`, `/assistant`, `/documents`, `/reports`, `/account`, `/organization`, `/notifications`, later `/fleet` and `/audit`.
- **Contract:** `src/lib/routes.ts` holds pure `parsePath` and `pathFor`, shared by the server page and the client. One optional catch-all page replaces `src/app/page.tsx`; anything that does not parse calls `notFound()`. Static routes (`/pricing`, `/demo`, …) and `/api` still win.
- **Client:** the workspace pushes a path when the section, open load, open invoice or open carrier changes, and follows Back, Forward and reload. The public demo keeps no URL sync.
- **Authorization:** unchanged and server-side. A deep link to a load the person cannot reach shows "not available to you" inside the workspace and never confirms existence. A signed-out visitor sees sign-in and lands on the link afterwards.
- **No DB change.** Rollback: restore `src/app/page.tsx`.
- **Tests:** unit for `parsePath`/`pathFor` round trips and rejection of bad ids; browser for load, invoice and carrier deep links, reload, Back, signed-out redirect-through-login, foreign or random id, driver deep link.

### 3. Sub-hourly scheduler

- **Intent:** two-hour appointment reminders and the delivery retry queue must run every 15 minutes; daily sweeps stay daily.
- **Contract:** `GET /api/jobs/notifications?scope=tick|daily` (default `daily` keeps today's behaviour). `tick` = appointment reminders + delivery; `daily` = the rest. Both bearer-authorized with `CRON_SECRET` as now. New `GET /api/jobs/status` (same bearer, plus admin session route below).
- **Domain:** a run takes a Postgres advisory lock per scope so overlapping triggers do not stack; a second caller gets `{ skipped: "running" }` with 200.
- **DB (migration 035, expand only):** `job_runs(id, job, scope, started_at, finished_at, outcome, detail jsonb, duration_ms)`; append-only for rows older than 30 days is not enforced, pruned by the daily run. Rollback: drop the table; nothing reads it except the new status code.
- **Trigger:** Vercel's cron stays daily (a sub-daily Vercel cron is rejected on the Hobby plan). `.github/workflows/scheduler.yml` calls the tick every 15 minutes, guarded by the repository variable `RELAY_JOBS_URL` and secret `CRON_SECRET`, so it does nothing until someone configures it. Documented alternatives: Vercel Pro cron, any external pinger.
- **Observability:** every run writes `job_runs`; the audit page shows last run per scope and flags it stale after three missed intervals; failures keep the error in `detail` and log `job.failed`.
- **Tests:** integration (auth, scope split, lock skip, run recorded on success and failure, dedupe still prevents duplicate reminders across repeated ticks, tick does not run daily sweeps).

### 4. Audit log page

- **Intent:** an organization owner or admin can see who did what, when, to what, and filter it.
- **DB (migration 036, expand → backfill → verify):** nullable `audit_logs.organization_id` (trailing column, so the ~30 existing positional `INSERT … VALUES` statements keep working), a `BEFORE INSERT` trigger that fills it from the actor's single organization when it is not set, and a backfill that disables the append-only trigger only for this migration. Rows whose actor belongs to several organizations or none stay NULL and are not shown (platform-level events). Rollback: drop trigger and column.
- **Contract:** `GET /api/audit?action=&actor=&from=&to=&cursor=` (cursor paging, 50 per page, newest first) and `GET /api/audit/actions`. Response fields are limited to time, actor name, action label and resource id; no payloads.
- **Authorization:** organization owners and admins only (`organization_members`); everyone else gets 404. Query is always filtered by the caller's organization. Reading the log is itself written to the log.
- **UX:** a new "Audit log" page in the sidebar for admins: filters, a table that pages with "Show more", an export-free read-only view, and a Scheduler panel from item 3. Human labels for known actions, raw action shown for unknown ones.
- **Tests:** integration (cross-organization isolation with guessed ids, non-admin 404, filters, cursor stability, trigger fills organization, backfill of old rows); browser (admin sees rows and filters; carrier manager has no page and gets 404 at `/audit`).

### 5. Fleet page

- **Intent:** dispatchers and carrier managers keep a list of each carrier's drivers and vehicles in one place.
- **DB (migration 037, expand only):** `vehicles` gains `kind`, `plate`, `vin`, `status` (`active|retired`), `version`, `created_at`, all nullable or defaulted; `label` stays the display name. `UNIQUE(carrier_id, label)` added only after a check that no duplicates exist (the migration fails loudly otherwise). Rollback: drop the added columns and constraint.
- **Contract:** `GET /api/fleet?carrier_id=`; `POST /api/fleet/vehicles`; `POST /api/fleet/vehicles/:id` (optimistic `version`); `POST /api/fleet/vehicles/:id/retire` and `/reactivate`. Mutations carry an idempotency key. Drivers keep their existing invite and remove endpoints; the page links to them.
- **Domain:** a retired vehicle cannot be chosen on a new assignment; existing assignments keep it. If the assign endpoint already accepts `vehicle_id`, the assign form gets a vehicle selector limited to the load's carrier.
- **Authorization:** dispatcher and carrier-manager for that carrier; drivers have no page; carrier B ids are 404.
- **Events/audit:** every change calls the existing `emit` helper.
- **Tests:** integration (create, update with stale version, retire, duplicate label, idempotent retry, cross-carrier and driver denial, assignment rules); browser (add, edit, retire, driver cannot reach `/fleet`).

## Test and rebuild cycle

1. After each commit: `npm run lint`, `npm run typecheck`, the integration files for that area, and the browser specs for that area against a fresh production build.
2. Before touching `main`: **build test** — migrate an empty database twice, seed, lint, typecheck, full `npm test`, `npm run build`, start, full Playwright suite.
3. **Rebuild test** — drop and recreate the database, repeat migrate-twice, seed, rebuild from a clean `.next`, restart, run the full Playwright suite again, and run the layout audit spec.
4. Only then fast-forward `main` (`git push origin HEAD:main`, no force) and push the branch. The CI `verify` job on the push is the third independent run; a red run is fixed before reporting done.

## Not in scope

Tracking and ETA, accounting and invoice PDF, CSV import, driver settlements, resumable uploads, per-stop events, retention policy (see the completeness audit).

## Result (2026-10-22)

All five items are built, in one commit each on top of `4c6166c`:

| Commit    | Item                                                    | ADR  | Migration |
| --------- | ------------------------------------------------------- | ---- | --------- |
| `8d115dd` | 404, error and global error pages                       | –    | –         |
| `e10aad8` | Addresses for every page, load, invoice and carrier     | 0045 | –         |
| `8f69dd8` | 15-minute scheduler scope, run records, status endpoint | 0046 | 035       |
| `1b079d6` | Audit log page                                          | 0047 | 036       |
| `0f8fb9a` | Fleet page and vehicle choice on assignment             | 0048 | 037       |

Verification: lint and typecheck clean. **Build test** on the existing QA database: 276 integration and 133 browser tests pass. **Rebuild test** on a dropped and recreated database (all 37 migrations applied twice, seeded, `.next` removed, `npm run build:vercel`, restarted): 276 integration and 133 browser tests pass again.

Defects found on the way and fixed in the same commits: the invoice sheet vanished when carriers were switched quickly in Billing (a slow earlier response overwrote a later one); a legacy `/?view=carriers` link was overridden by address handling; hidden screen-reader text inside a scrolling table widened the page on phones.

Left alone: Next.js answers 500 to a malformed `%` escape on any path (framework behaviour); nothing is scheduled or deployed by the scheduler change until `RELAY_JOBS_URL` and `CRON_SECRET` are set.
