# 0005 — Prepare the database before Vercel Production builds

Status: accepted, 2026-10-21.

Hosted login logs showed `ECONNREFUSED 127.0.0.1:5432` before database configuration, then `relation "login_attempts" does not exist` after connecting PostgreSQL. The database became reachable, but the compile-only deployment path never applied migrations. A public login request independently returned HTTP503.

Use `npm run build:vercel` as the repository's Vercel build command. Its preparation script requires `DATABASE_URL` and runs the existing transaction/advisory-lock migration runner when `VERCEL_ENV=production`. Compile Next.js only after preparation succeeds. This makes a main-branch deployment apply pending migrations without a separate manual terminal step; migration failure stops the release. Concurrent/repeated builds serialize migrations and skip recorded versions. No DDL is added to authentication requests.

Preview and local builds never run preparation, even if they inherit a database URL or QA flag. Preview databases must be migrated explicitly. Plain `npm run build` remains a database-independent compile. CI separately exercises the Production build path against fictional PostgreSQL.

Account setup is independent of schema deployment. `RELAY_QA_SEED=true` plus a private `SEED_PASSWORD` of at least12 characters explicitly enables the existing idempotent fictional seed for a dedicated hosted QA database. Validate the opt-in and password before any database preparation. No password is hardcoded or committed; no QA seeding occurs by default, and repeat seed never resets existing passwords. Never enable it against real operational data.

Current migrations001–003 are additive and compatible with the previous app. They remain applied if compilation fails or the app is rolled back. Rollback restores the previous application without dropping schema or data. Future destructive migrations need an explicit compatibility/release plan; this hook is not permission to run them automatically. An unversioned, manually modified schema must be reviewed and baselined rather than silently adopted by this script.
