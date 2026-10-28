-- Factoring handoff (ADR 0069). Expand-only: three new tables. Rollback: leave
-- them; nothing else reads them.
--
-- Relay prepares a schedule of the carrier's invoices for the carrier's factor
-- and records that the carrier handed it over. Relay sends nothing to a factor.
-- The carrier consents, per carrier, to sharing its billing data this way.
CREATE TABLE carrier_factoring (
  carrier_id uuid PRIMARY KEY REFERENCES carriers,
  enabled boolean NOT NULL DEFAULT false,
  factor_name text NOT NULL DEFAULT '' CHECK(length(factor_name)<=160),
  consented_by uuid REFERENCES users,
  consented_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT enabled OR (factor_name<>'' AND consented_by IS NOT NULL AND consented_at IS NOT NULL))
);
CREATE TABLE factoring_batches (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  factor_name text NOT NULL CHECK(length(factor_name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','handed_off','void')),
  load_count integer NOT NULL CHECK(load_count>0),
  total_minor bigint NOT NULL CHECK(total_minor>0 AND total_minor<=9007199254740991),
  file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[0-9a-f]{64}$'),
  file_csv text NOT NULL,
  payout_change_id uuid REFERENCES sensitive_changes,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  handed_off_at timestamptz,
  handed_off_by uuid REFERENCES users,
  voided_at timestamptz,
  voided_by uuid REFERENCES users,
  void_reason text CHECK(length(void_reason) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK(status<>'handed_off' OR handed_off_at IS NOT NULL),
  CHECK((status='void')=(voided_at IS NOT NULL)),
  UNIQUE(created_by,idempotency_key),
  UNIQUE(id,carrier_id)
);
CREATE INDEX factoring_batches_by_carrier ON factoring_batches(carrier_id,created_at DESC);
CREATE TABLE factoring_batch_loads (
  batch_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  load_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  -- Cleared only when the batch is voided, releasing the load for a new batch.
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY(batch_id,carrier_id) REFERENCES factoring_batches(id,carrier_id),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id)
);
CREATE UNIQUE INDEX factoring_load_once ON factoring_batch_loads(load_id) WHERE active;
CREATE INDEX factoring_lines_by_batch ON factoring_batch_loads(batch_id);
