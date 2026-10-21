-- Per-stop arrival and departure times, reported manually with provenance.
-- Rows are immutable; a correction is a new row that supersedes the current
-- one for the same stop and kind, so each chain is linear and fully kept.
ALTER TABLE load_stops ADD CONSTRAINT load_stops_id_load UNIQUE(id,load_id);
CREATE TABLE stop_events (
  id uuid PRIMARY KEY,
  load_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('arrived','departed')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL REFERENCES users,
  source text NOT NULL DEFAULT 'manual' CHECK(source='manual'),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
  supersedes uuid REFERENCES stop_events,
  reason text CHECK(length(reason) BETWEEN 1 AND 500),
  load_version integer NOT NULL CHECK(load_version>1),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK((supersedes IS NULL)=(reason IS NULL)),
  FOREIGN KEY(stop_id,load_id) REFERENCES load_stops(id,load_id),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(actor_id,idempotency_key)
);
-- Only one correction may follow any given report.
CREATE UNIQUE INDEX stop_event_single_successor ON stop_events(supersedes) WHERE supersedes IS NOT NULL;
-- Only one uncorrected first report per stop and kind.
CREATE UNIQUE INDEX stop_event_single_origin ON stop_events(stop_id,kind) WHERE supersedes IS NULL;
CREATE INDEX stop_event_history ON stop_events(load_id,stop_id,kind,recorded_at);
CREATE TRIGGER immutable_stop_events BEFORE UPDATE OR DELETE ON stop_events
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
