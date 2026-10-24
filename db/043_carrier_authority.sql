-- Carrier authority monitoring (ADR 0065). Expand-only: one new append-only
-- table. Rollback: leave it; nothing else reads it.
--
-- Each row is one lookup of a carrier's public registration, with its source
-- and the time it was observed. A lookup is an observation, not a guarantee:
-- the screen always shows where it came from and how old it is.
CREATE TABLE carrier_authority_checks (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  usdot text NOT NULL CHECK(usdot ~ '^[0-9]{1,8}$'),
  source text NOT NULL CHECK(source IN ('fixture','fmcsa')),
  outcome text NOT NULL CHECK(outcome IN ('ok','not_found','error')),
  legal_name text NOT NULL DEFAULT '' CHECK(length(legal_name)<=200),
  authority_status text NOT NULL DEFAULT 'unknown' CHECK(authority_status IN ('active','inactive','revoked','unknown')),
  allowed_to_operate boolean,
  out_of_service boolean,
  insurance_on_file boolean,
  error_code text CHECK(length(error_code)<=60),
  observed_at timestamptz NOT NULL,
  checked_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(outcome<>'error' OR error_code IS NOT NULL)
);
CREATE INDEX carrier_authority_latest ON carrier_authority_checks(carrier_id,created_at DESC,id DESC);
CREATE TRIGGER immutable_carrier_authority BEFORE UPDATE OR DELETE ON carrier_authority_checks
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
