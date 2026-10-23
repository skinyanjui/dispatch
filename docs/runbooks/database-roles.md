# Database roles

**Why:** the app role that serves requests should not own the tables. A table owner can `ALTER TABLE ... DISABLE TRIGGER`, which switches off the append-only triggers on audit logs, check-ins, document versions and provider receipts (migration 036 and others), or drop and rewrite anything. Splitting the roles means a compromised app, or an injection that reached SQL, cannot rewrite history.

**Steps (expand, verify, contract):**

1. Back up. Review `docs/runbooks/database-roles.sql`, set real passwords, and run it as a superuser during a quiet period.
2. Add `MIGRATION_DATABASE_URL` (the `relay_owner` login) to the build environment only; keep `DATABASE_URL` (the `relay_app` login) for the running app. `npm run db:migrate` and the Vercel production build prefer `MIGRATION_DATABASE_URL` when it is set.
3. Verify as `relay_app`: the app works end to end; `ALTER TABLE audit_logs DISABLE TRIGGER immutable_audit;` and `TRUNCATE audit_logs;` are refused; `UPDATE audit_logs ...` is refused by the trigger.
4. Verify a new migration as `relay_owner` and confirm the app can read and write the new table.

**Rollback:** point `DATABASE_URL` back at the previous login; nothing in the schema changed except ownership and grants. To restore the old ownership, `ALTER TABLE ... OWNER TO <previous owner>` for each table.

**Not covered:** managed databases that do not allow `ALTER ... OWNER` (use the provider's role model); row-level security per organization is a separate decision.
