-- Two database roles (docs/runbooks/database-roles.md). Run once as a superuser
-- or the current table owner, replacing the passwords. Review before running.
--   relay_owner: owns the schema; used only by migrations (MIGRATION_DATABASE_URL).
--   relay_app:   used by the running app (DATABASE_URL); cannot change tables,
--                disable triggers, or truncate, so the append-only audit and
--                evidence triggers cannot be switched off from the app.
CREATE ROLE relay_owner LOGIN PASSWORD 'CHANGE-ME-owner';
CREATE ROLE relay_app LOGIN PASSWORD 'CHANGE-ME-app';

-- Hand existing objects to the owner (adjust the database and schema names).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO relay_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO relay_owner', r.sequencename);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO relay_owner', r.sig);
  END LOOP;
END $$;
GRANT ALL ON SCHEMA public TO relay_owner;
GRANT USAGE ON SCHEMA public TO relay_app;
REVOKE CREATE ON SCHEMA public FROM relay_app, PUBLIC;

-- The app reads and writes rows only. Triggers still stop UPDATE and DELETE on
-- append-only tables for everyone.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO relay_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO relay_app;
-- schema_migrations is the owner's.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM relay_app;

-- Tables the owner creates in later migrations get the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO relay_app;
