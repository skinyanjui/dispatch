-- Load exceptions are their own aggregate with an optimistic version. They are
-- never closed by milestone changes; history is the load event stream.
CREATE TABLE load_exceptions (
  id uuid PRIMARY KEY,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('delay','missed_appointment','missing_document','other')),
  severity text NOT NULL CHECK(severity IN ('low','medium','high')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved')),
  summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 200),
  details text NOT NULL DEFAULT '' CHECK(length(details)<=1000),
  document_type text CHECK(document_type IN ('rate_confirmation','bol','pod')),
  owner_id uuid REFERENCES users,
  due_at timestamptz,
  opened_by uuid NOT NULL REFERENCES users,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users,
  resolved_at timestamptz,
  resolution text CHECK(length(resolution) BETWEEN 1 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK((type='missing_document')=(document_type IS NOT NULL)),
  CHECK((status='resolved')=(resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL)),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(opened_by,idempotency_key)
);
CREATE INDEX exception_queue ON load_exceptions(carrier_id,status,opened_at DESC);
CREATE INDEX exception_owner ON load_exceptions(owner_id,status) WHERE status<>'resolved';
CREATE INDEX exception_load ON load_exceptions(load_id,opened_at DESC);
