-- Rate confirmation to draft load (ADR 0032). Expand-only: one new table, no
-- change to existing rows. Rollback: leave it; code that ignores it behaves as
-- before. A reading stores no file bytes: the person's browser keeps the file
-- and attaches it to the load through the normal document upload once the
-- load exists. This row is the provenance (who read which file, with what
-- model, at what cost) and links to the load a person created from it.
CREATE TABLE rate_confirmation_reads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  carrier_id uuid NOT NULL REFERENCES carriers,
  requested_by uuid NOT NULL REFERENCES users,
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK(size_bytes>0),
  status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
  error_code text,
  fields jsonb,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens integer CHECK(input_tokens>=0),
  output_tokens integer CHECK(output_tokens>=0),
  reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
  cost_micros bigint CHECK(cost_micros>=0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  -- Set once, in the same transaction that creates the load.
  load_id uuid REFERENCES loads,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(requested_by,idempotency_key),
  UNIQUE(load_id)
);
CREATE INDEX rate_reads_spend ON rate_confirmation_reads(organization_id,created_at);
