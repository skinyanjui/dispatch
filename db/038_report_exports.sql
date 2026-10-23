CREATE TABLE report_exports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  filters jsonb NOT NULL,
  carrier_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed')),
  filename text,
  row_count integer,
  artifact bytea,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX report_exports_work ON report_exports(status,created_at);
