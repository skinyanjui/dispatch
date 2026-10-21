-- Object location: bytes stay in PostgreSQL or live in an S3-compatible
-- bucket. Existing rows are 'postgres'. The only permitted change to an
-- object row is moving it from postgres to s3 (bytes cleared, bucket set).
ALTER TABLE document_objects ALTER COLUMN content DROP NOT NULL;
ALTER TABLE document_objects ADD COLUMN backend text NOT NULL DEFAULT 'postgres'
  CHECK(backend IN ('postgres','s3'));
ALTER TABLE document_objects ADD COLUMN bucket text;
ALTER TABLE document_objects ADD COLUMN migrated_at timestamptz;
ALTER TABLE document_objects ADD CONSTRAINT document_object_location CHECK(
  (backend='postgres' AND content IS NOT NULL AND bucket IS NULL) OR
  (backend='s3' AND content IS NULL AND bucket IS NOT NULL));

DROP TRIGGER immutable_document_objects ON document_objects;
CREATE FUNCTION document_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.storage_key<>NEW.storage_key OR OLD.backend<>'postgres'
    OR NEW.backend<>'s3' OR NEW.migrated_at IS NULL THEN
    RAISE EXCEPTION 'Append-only record';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_document_objects BEFORE UPDATE OR DELETE ON document_objects
  FOR EACH ROW EXECUTE FUNCTION document_object_guard();

-- Malware scan log. Infected uploads are recorded without a version (their
-- bytes are never stored); clean scans reference the version they cleared.
CREATE TABLE document_scans (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  version_id uuid,
  actor_id uuid NOT NULL REFERENCES users,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  filename text NOT NULL,
  verdict text NOT NULL CHECK(verdict IN ('clean','infected')),
  engine text NOT NULL,
  signature text CHECK(length(signature)<=200),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  CHECK(verdict='clean' OR version_id IS NULL),
  FOREIGN KEY(version_id,carrier_id) REFERENCES document_versions(id,carrier_id)
);
CREATE INDEX document_scans_by_version ON document_scans(version_id);
CREATE INDEX document_scans_by_carrier ON document_scans(carrier_id,scanned_at DESC);
CREATE TRIGGER immutable_document_scans BEFORE UPDATE OR DELETE ON document_scans
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
