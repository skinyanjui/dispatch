-- Inbound attachments and cleanup of abandoned uploads (ADR 0025).
-- Inbound files have no Relay uploader; they exist only linked to a message.
ALTER TABLE message_attachments ALTER COLUMN uploader_id DROP NOT NULL;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_owner_or_message
  CHECK(uploader_id IS NOT NULL OR message_id IS NOT NULL);

-- Only a file that was never attached may be removed.
CREATE OR REPLACE FUNCTION guard_message_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.message_id IS NOT NULL THEN RAISE EXCEPTION 'Attached files are kept'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.message_id IS NOT NULL OR NEW.id<>OLD.id OR NEW.storage_key<>OLD.storage_key
     OR NEW.sha256<>OLD.sha256 OR NEW.uploader_id IS DISTINCT FROM OLD.uploader_id THEN
    RAISE EXCEPTION 'Attachments are immutable once linked';
  END IF;
  RETURN NEW;
END $$;

-- Document files stay append-only, except the byte rows of abandoned message
-- attachments (their foreign key already blocks deleting any that are in use).
CREATE OR REPLACE FUNCTION document_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.storage_key LIKE 'message-attachments/%' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Append-only record';
  END IF;
  IF OLD.storage_key<>NEW.storage_key OR OLD.backend<>'postgres'
    OR NEW.backend<>'s3' OR NEW.migrated_at IS NULL THEN
    RAISE EXCEPTION 'Append-only record';
  END IF;
  RETURN NEW;
END $$;
