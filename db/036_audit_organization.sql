-- Audit log by organization (ADR 0047). Expand -> backfill -> verify.
--
-- EXPAND: a trailing nullable column, so the ~30 existing positional
-- `INSERT INTO audit_logs VALUES(...)` statements keep working unchanged.
ALTER TABLE audit_logs ADD COLUMN organization_id uuid REFERENCES organizations;
CREATE INDEX audit_logs_by_organization ON audit_logs(organization_id,created_at DESC,id DESC);

-- New rows: the organization of the actor, when the actor belongs to exactly
-- one (as an owner/admin or through a carrier membership). A row whose actor
-- has several organizations or none stays NULL and is not shown to anyone.
CREATE FUNCTION audit_set_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE orgs uuid[];
BEGIN
  IF NEW.organization_id IS NULL AND NEW.actor_id IS NOT NULL THEN
    SELECT array_agg(DISTINCT o) INTO orgs FROM (
      SELECT organization_id o FROM organization_members WHERE user_id=NEW.actor_id
      UNION
      SELECT c.organization_id FROM memberships m JOIN carriers c ON c.id=m.carrier_id WHERE m.user_id=NEW.actor_id
    ) x;
    IF cardinality(orgs)=1 THEN NEW.organization_id := orgs[1]; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_organization BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_set_organization();

-- BACKFILL: the same rule for existing rows. The append-only trigger is off
-- only for this one statement, inside this migration's transaction.
ALTER TABLE audit_logs DISABLE TRIGGER immutable_audit;
UPDATE audit_logs a SET organization_id=s.org
FROM (
  SELECT actor_id,(array_agg(DISTINCT o))[1] org FROM (
    SELECT user_id actor_id,organization_id o FROM organization_members
    UNION
    SELECT m.user_id,c.organization_id FROM memberships m JOIN carriers c ON c.id=m.carrier_id
  ) x GROUP BY actor_id HAVING count(DISTINCT o)=1
) s
WHERE a.actor_id=s.actor_id AND a.organization_id IS NULL;
ALTER TABLE audit_logs ENABLE TRIGGER immutable_audit;

-- VERIFY: nothing that the rule covers was missed, and the log is append-only
-- again. A failure aborts the migration and leaves the schema untouched.
DO $$
DECLARE missed integer; armed boolean;
BEGIN
  SELECT count(*) INTO missed FROM audit_logs a WHERE a.organization_id IS NULL AND a.actor_id IS NOT NULL
    AND (SELECT count(DISTINCT o) FROM (
      SELECT organization_id o FROM organization_members WHERE user_id=a.actor_id
      UNION SELECT c.organization_id FROM memberships m JOIN carriers c ON c.id=m.carrier_id WHERE m.user_id=a.actor_id) y)=1;
  IF missed>0 THEN RAISE EXCEPTION 'audit backfill missed % rows', missed; END IF;
  SELECT tgenabled='O' INTO armed FROM pg_trigger WHERE tgname='immutable_audit' AND tgrelid='audit_logs'::regclass;
  IF NOT coalesce(armed,false) THEN RAISE EXCEPTION 'audit_logs append-only trigger is not enabled'; END IF;
END $$;

-- ROLLBACK (manual): DROP TRIGGER audit_organization ON audit_logs;
--   DROP FUNCTION audit_set_organization(); DROP INDEX audit_logs_by_organization;
--   ALTER TABLE audit_logs DROP COLUMN organization_id;
