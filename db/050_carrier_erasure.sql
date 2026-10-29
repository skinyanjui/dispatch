-- Carrier erasure on request (ADR 0074). Expand-only.
-- Rollback: leave the column, table and functions; nothing calls them if the
-- code is reverted. Erased data cannot be restored from here (only from backups).

ALTER TABLE sensitive_changes DROP CONSTRAINT sensitive_changes_kind_check;
ALTER TABLE sensitive_changes ADD CONSTRAINT sensitive_changes_kind_check
  CHECK(kind IN ('payout_details','contact_details','reroute','carrier_profile','carrier_erasure'));

ALTER TABLE carriers ADD COLUMN erased_at timestamptz;

-- Append-only history may be scrubbed or deleted only inside an erasure's own
-- transaction, which says so with relay.erasure=on. Anyone with database access
-- could set that; it guards against application mistakes, not administrators.
CREATE FUNCTION immutable_unless_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('relay.erasure', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Append-only record';
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['load_notes','check_ins','check_in_amendments','stop_events',
    'document_versions','document_scans','membership_removals','onboarding_events'] LOOP
    EXECUTE format('DROP TRIGGER immutable_%s ON %I', t, t);
    EXECUTE format('CREATE TRIGGER immutable_%s BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_unless_erasure()', t, t);
  END LOOP;
END $$;

-- Lookup history: the retention job or an erasure may delete (never edit) rows.
CREATE OR REPLACE FUNCTION immutable_unless_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (current_setting('relay.retention', true) = 'on'
                           OR current_setting('relay.erasure', true) = 'on') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Append-only record';
END $$;

-- Stored files: an erasure empties the bytes (or queues the bucket delete) and
-- marks the object purged; the row and its hash stay.
ALTER TABLE document_objects ADD COLUMN purged_at timestamptz;
CREATE OR REPLACE FUNCTION document_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.storage_key LIKE 'message-attachments/%' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Append-only record';
  END IF;
  IF current_setting('relay.erasure', true) = 'on'
    AND OLD.storage_key = NEW.storage_key AND OLD.backend = NEW.backend
    AND NEW.purged_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.storage_key<>NEW.storage_key OR OLD.backend<>'postgres'
    OR NEW.backend<>'s3' OR NEW.migrated_at IS NULL THEN
    RAISE EXCEPTION 'Append-only record';
  END IF;
  RETURN NEW;
END $$;

-- Attached files stay immutable, except that an erasure may rename them.
CREATE OR REPLACE FUNCTION guard_message_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.message_id IS NOT NULL THEN RAISE EXCEPTION 'Attached files are kept'; END IF;
    RETURN OLD;
  END IF;
  IF current_setting('relay.erasure', true) = 'on' AND NEW.id=OLD.id AND NEW.storage_key=OLD.storage_key
     AND NEW.sha256=OLD.sha256 AND NEW.uploader_id IS NOT DISTINCT FROM OLD.uploader_id THEN
    RETURN NEW;
  END IF;
  IF OLD.message_id IS NOT NULL OR NEW.id<>OLD.id OR NEW.storage_key<>OLD.storage_key
     OR NEW.sha256<>OLD.sha256 OR NEW.uploader_id IS DISTINCT FROM OLD.uploader_id THEN
    RAISE EXCEPTION 'Attachments are immutable once linked';
  END IF;
  RETURN NEW;
END $$;

-- Bucket objects whose delete has to be retried until the store confirms it.
CREATE TABLE erasure_object_deletions (
  storage_key text PRIMARY KEY REFERENCES document_objects,
  carrier_id uuid NOT NULL REFERENCES carriers,
  change_id uuid NOT NULL REFERENCES sensitive_changes,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error text CHECK(length(last_error)<=200),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE INDEX erasure_object_deletions_due ON erasure_object_deletions(created_at) WHERE done_at IS NULL;
