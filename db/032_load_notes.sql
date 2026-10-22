-- Internal notes on a load (ADR 0037). Expand-only: one new table.
-- Notes are for the dispatch company and the carrier's managers; drivers
-- cannot see them. Append-only: a mistake is corrected with a new note.
-- Rollback: leave the table; code that ignores it behaves as before.
CREATE TABLE load_notes (
  id uuid PRIMARY KEY,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(author_id,idempotency_key)
);
CREATE INDEX load_notes_by_load ON load_notes(load_id,created_at DESC,id DESC);
CREATE TRIGGER immutable_load_notes BEFORE UPDATE OR DELETE ON load_notes
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
