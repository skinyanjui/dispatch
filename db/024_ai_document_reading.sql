-- AI document reading (ADR 0028). Expand-only: two new tables, no changes to
-- existing rows. Rollback: leave the tables in place; code that ignores them
-- behaves as before, and AI stays off because nothing is enabled by default.

-- Consent and spend limit, per organization. Off until an owner or admin
-- turns it on, because enabling it sends that organization's paperwork to the
-- model provider.
CREATE TABLE organization_ai_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations,
  extraction_enabled boolean NOT NULL DEFAULT false,
  monthly_limit_cents integer NOT NULL DEFAULT 1000
    CHECK(monthly_limit_cents BETWEEN 0 AND 1000000),
  enabled_by uuid REFERENCES users,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per request to read a document version. The model's suggestions are
-- stored as provenance (provider, model, prompt version, tokens, cost) and
-- never change the document, the load or any billing record. Money is held in
-- micro-dollars (1 USD = 1,000,000) as integers.
CREATE TABLE document_extractions (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations,
  doc_type text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed','dismissed')),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  fields jsonb,
  error_code text,
  input_tokens integer CHECK(input_tokens>=0),
  output_tokens integer CHECK(output_tokens>=0),
  reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
  cost_micros bigint CHECK(cost_micros>=0),
  requested_by uuid NOT NULL REFERENCES users,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  checked_by uuid REFERENCES users,
  checked_at timestamptz,
  checked_fields jsonb,
  FOREIGN KEY(version_id,carrier_id) REFERENCES document_versions(id,carrier_id),
  UNIQUE(requested_by,idempotency_key),
  CHECK(status<>'succeeded' OR fields IS NOT NULL),
  CHECK((checked_by IS NULL)=(checked_at IS NULL))
);
CREATE INDEX document_extractions_by_version ON document_extractions(version_id,created_at DESC);
CREATE INDEX document_extractions_spend ON document_extractions(organization_id,created_at);
