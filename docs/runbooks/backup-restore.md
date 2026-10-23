# Backup, restore and schema rollback

**Backups.** Use the database provider's automated backups with point-in-time recovery and at least 7 days of retention; take a manual `pg_dump --format=custom` before any migration that changes or rewrites data. Document files in object storage are versioned and never overwritten, so enable bucket versioning and restrict deletion; stored files and the database must be restored to the same point (document rows hold the object keys and SHA-256 checksums, which the app verifies on read).

**Prove the restore works.** `npm run db:restore-drill` dumps `DATABASE_URL`, restores into a scratch database on the same server, then fails unless row counts, the latest migration and the armed append-only audit trigger all match. Run it monthly and after changing the database role setup. It needs `pg_dump`, `pg_restore` and `psql` at the server's version or newer, and permission to create a database. Last local run: OK against migrations through 041.

**Restore for real.**

1. Stop writes (set the deployment to maintenance or revoke the app role's login).
2. Restore the chosen backup into a new database; never over the live one.
3. Run `npm run db:migrate` against it; it applies only the migrations the backup lacks.
4. Check `GET /api/operations/status` (schema version, scheduler) and sign-in, then point `DATABASE_URL` at it.
5. Messages sent between the backup point and the failure are not in the backup: review the provider logs before resending anything, because notifications are idempotent only within the database.
6. Keep `RELAY_DATA_KEY` (and `RELAY_DATA_KEY_PREVIOUS` if a rotation was in progress) with the backups' retention period; without the key that was current at backup time, queued message bodies and second-factor secrets cannot be read.

**Schema rollback.** Migrations are expand-only: they add tables, columns and indexes and never drop or rewrite in place, so the previous code keeps working against a newer schema. Roll back by redeploying the previous commit. Each migration file ends with a `ROLLBACK (manual)` note for removing what it added once nothing reads it; run those only after the code that uses them is gone. A change that cannot be expand-only (dropping a column) needs a backfill, a release that no longer reads it, and then the contract step in a later migration.
