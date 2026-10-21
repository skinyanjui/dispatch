-- Append-only observations. Event time is distinct from the database receipt time;
-- entering a check-in never changes the load's shipment milestone.
CREATE TABLE check_ins (
  id uuid PRIMARY KEY,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users,
  source text NOT NULL DEFAULT 'manual' CHECK(source='manual'),
  location text NOT NULL CHECK(length(location) BETWEEN 1 AND 160),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  load_version integer NOT NULL CHECK(load_version>1),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX check_in_history ON check_ins(load_id,observed_at DESC,recorded_at DESC,id DESC);
CREATE TRIGGER immutable_check_ins BEFORE UPDATE OR DELETE ON check_ins
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
