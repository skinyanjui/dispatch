-- Idempotent load edit/cancel (ADR 0026). Expand-only: one new table, no
-- changes to existing rows. A retried request with the same key and body
-- replays the stored result instead of failing on the bumped version.
-- Rollback: leave the table in place; code that ignores it behaves as before.
CREATE TABLE load_change_requests (
  actor_id uuid NOT NULL REFERENCES users,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('edit','cancel')),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id)
);
CREATE INDEX load_change_requests_by_load ON load_change_requests(load_id);
CREATE TRIGGER immutable_load_change_requests BEFORE UPDATE OR DELETE ON load_change_requests FOR EACH ROW EXECUTE FUNCTION immutable_event();
