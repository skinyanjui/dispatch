-- Corrections and retractions of manual check-ins. The original report stays
-- immutable; the effective report is the original overlaid by its latest
-- correction, and a retraction is final.
ALTER TABLE check_ins ADD CONSTRAINT check_ins_id_load UNIQUE(id,load_id);
CREATE TABLE check_in_amendments (
  id uuid PRIMARY KEY,
  check_in_id uuid NOT NULL,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users,
  action text NOT NULL CHECK(action IN ('correct','retract')),
  location text CHECK(length(location) BETWEEN 1 AND 160),
  note text CHECK(length(note)<=1000),
  observed_at timestamptz,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  load_version integer NOT NULL CHECK(load_version>1),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK((action='correct')=(location IS NOT NULL AND note IS NOT NULL AND observed_at IS NOT NULL)),
  FOREIGN KEY(check_in_id,load_id) REFERENCES check_ins(id,load_id),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX check_in_amendment_history ON check_in_amendments(check_in_id,created_at DESC,id DESC);
-- At most one retraction per report.
CREATE UNIQUE INDEX check_in_single_retraction ON check_in_amendments(check_in_id) WHERE action='retract';
CREATE TRIGGER immutable_check_in_amendments BEFORE UPDATE OR DELETE ON check_in_amendments
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
-- Descending timeline paging.
CREATE INDEX event_timeline_desc ON load_events(load_id,created_at DESC,id DESC);
