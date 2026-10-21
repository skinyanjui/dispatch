-- Files attached to messages (ADR 0022). Bytes live in document_objects like
-- every other stored file; this table records who uploaded what and where it
-- was attached. A file is uploaded first (scanned, unattached), then linked
-- once to a message by its uploader; links are never changed.
CREATE TABLE message_attachments (
  id uuid PRIMARY KEY,
  uploader_id uuid NOT NULL REFERENCES users,
  message_id uuid REFERENCES messages,
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes>0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL UNIQUE REFERENCES document_objects(storage_key),
  scan text NOT NULL CHECK(scan IN ('clean','not_scanned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz,
  CHECK((message_id IS NULL)=(linked_at IS NULL))
);
CREATE INDEX message_attachments_by_message ON message_attachments(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX message_attachments_unlinked ON message_attachments(uploader_id,created_at) WHERE message_id IS NULL;
-- Linking is the only permitted change.
CREATE FUNCTION guard_message_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attachments are kept'; END IF;
  IF OLD.message_id IS NOT NULL OR NEW.id<>OLD.id OR NEW.storage_key<>OLD.storage_key
     OR NEW.sha256<>OLD.sha256 OR NEW.uploader_id<>OLD.uploader_id THEN
    RAISE EXCEPTION 'Attachments are immutable once linked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_message_attachments BEFORE UPDATE OR DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION guard_message_attachments();
