# Hosted login deployment fix — 2026-10-21

The user supplied Vercel logs showing login HTTP503: first `ECONNREFUSED 127.0.0.1:5432`, then `relation "login_attempts" does not exist` after connecting PostgreSQL. An independent request to `https://dispatch-nine-pearl.vercel.app/api/login` reproduced HTTP503 with `SERVICE_UNAVAILABLE`. The later logs establish that PostgreSQL is reachable but migration002 has not created shared authentication controls; they do not establish whether foundation tables or QA accounts exist.

The repository previously compiled the app without applying migrations. `vercel.json` now installs all build tools explicitly and runs `npm run build:vercel`. The preparation script applies pending migrations001–003 before Next.js compilation for `VERCEL_ENV=production`. Missing configuration or migration failure stops the build. Preview and local builds skip preparation. Existing `npm run build` remains a database-independent compile. The migration runner already serializes concurrent builds with a transaction advisory lock and records applied versions.

QA login creation requires the explicit `RELAY_QA_SEED=true` flag and a private `SEED_PASSWORD` of at least12 characters in Vercel's Production variables. This is for a dedicated fictional QA database only. A password is never hardcoded, copied from the development workspace, printed by preparation, or reset by a repeat build. The default path only migrates and preserves existing accounts. The build validates QA configuration before writes and never seeds a preview database. No DDL or bypass was added to the login handler.

Verification:

- Lint and TypeScript pass; `git diff --check` passes.
- **59 tests pass, zero skipped:** 3 prototype smoke, 28 unit/database/API integration, 28 Chromium browser tests.
- Five new deployment tests cover an empty database, a foundation-only upgrade missing `login_attempts`, repeat migration/seed without password resets, missing configuration, failed migration stopping preparation, and preview isolation.
- The Production build path ran against local QA PostgreSQL, applied pending migrations, reported completion, and compiled the optimized Next.js app successfully.
- Disposable databases used by deployment tests were removed. An initial test attempt found the local PostgreSQL container stopped after workspace restart; restarting the existing service resolved that environment prerequisite before the passing gates.

Local checks do not prove a Vercel deployment succeeded. After the main-branch push, verify the hosted endpoint and Vercel build logs separately. Build logs should contain `Production database preparation complete.` Existing project overrides must use `npm run build:vercel` or defer to the repository configuration. Runtime variable changes require a new deployment.

Rollback: restore the previous app while retaining applied schema and account records. Do not drop tables or migration history. Current migrations are additive; future incompatible migrations require a reviewed compatibility plan. See ADR0005 and README for setup and recovery details.
