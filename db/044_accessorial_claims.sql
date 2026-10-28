-- Detention and truck-ordered-not-used (TONU) evidence (ADR 0067). Expand-only:
-- two new tables. Rollback: leave them; nothing else reads them.
--
-- Terms are what the rate confirmation (or agreement) says about free time, the
-- hourly rate and the TONU fee. A claim freezes the evidence it was made from,
-- so later corrections to the load do not silently rewrite a submitted claim.
CREATE TABLE detention_terms (
  load_id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL,
  free_minutes integer NOT NULL CHECK(free_minutes BETWEEN 0 AND 1440),
  rate_minor_per_hour bigint NOT NULL CHECK(rate_minor_per_hour BETWEEN 0 AND 9007199254740991),
  cap_minutes integer CHECK(cap_minutes BETWEEN 1 AND 4320),
  tonu_minor bigint CHECK(tonu_minor BETWEEN 1 AND 9007199254740991),
  source text NOT NULL CHECK(source IN ('rate_confirmation','agreement','verbal')),
  set_by uuid NOT NULL REFERENCES users,
  set_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id)
);
CREATE TABLE accessorial_claims (
  id uuid PRIMARY KEY,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('detention','tonu')),
  stop_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','paid','denied')),
  claimed_minor bigint NOT NULL CHECK(claimed_minor BETWEEN 1 AND 9007199254740991),
  settled_minor bigint CHECK(settled_minor BETWEEN 0 AND 9007199254740991),
  evidence jsonb NOT NULL,
  note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  submitted_by uuid REFERENCES users,
  settled_at timestamptz,
  settled_by uuid REFERENCES users,
  outcome_note text NOT NULL DEFAULT '' CHECK(length(outcome_note)<=500),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK((kind='detention')=(stop_id IS NOT NULL)),
  CHECK((status IN ('draft'))=(submitted_at IS NULL)),
  CHECK((status IN ('paid','denied'))=(settled_at IS NOT NULL)),
  CHECK(status<>'paid' OR settled_minor>0),
  CHECK(status<>'denied' OR settled_minor IS NULL),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  FOREIGN KEY(stop_id,load_id) REFERENCES load_stops(id,load_id),
  UNIQUE(created_by,idempotency_key)
);
-- One open claim per load, kind and stop; a denied or paid one frees the slot.
CREATE UNIQUE INDEX accessorial_one_open
  ON accessorial_claims(load_id,kind,COALESCE(stop_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('draft','submitted');
CREATE INDEX accessorial_by_carrier ON accessorial_claims(carrier_id,created_at DESC);
