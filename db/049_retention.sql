-- Retention for bulky or old records (ADR 0073). Expand-only.
-- Rollback: leave the column and trigger function; the job simply stops running
-- if removed from the daily steps. Purged files cannot be restored from here.

-- A factoring schedule's CSV can be purged after the retention period; its hash,
-- count and total stay, and the row says when the file went.
ALTER TABLE factoring_batches ALTER COLUMN file_csv DROP NOT NULL;
ALTER TABLE factoring_batches ADD COLUMN file_purged_at timestamptz;
ALTER TABLE factoring_batches ADD CONSTRAINT factoring_file_kept_or_purged
  CHECK(file_csv IS NOT NULL OR file_purged_at IS NOT NULL);

-- Lookup history stays append-only (no edits, no deletes) except that the
-- retention job may delete old rows inside a transaction that says so.
CREATE FUNCTION immutable_unless_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('relay.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Append-only record';
END $$;
DROP TRIGGER immutable_carrier_authority ON carrier_authority_checks;
CREATE TRIGGER immutable_carrier_authority BEFORE UPDATE OR DELETE ON carrier_authority_checks
  FOR EACH ROW EXECUTE FUNCTION immutable_unless_retention();
