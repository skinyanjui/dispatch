-- Hardening after the money-controls audit (ADR 0070). Expand-only.
-- Rollback: leave the columns; code that ignores them behaves as before except
-- that the guarded paths would again apply directly.

-- A change to the carrier's own setup details (name, contact email, phone, USDOT)
-- is a sensitive change too.
ALTER TABLE sensitive_changes DROP CONSTRAINT sensitive_changes_kind_check;
ALTER TABLE sensitive_changes ADD CONSTRAINT sensitive_changes_kind_check
  CHECK(kind IN ('payout_details','contact_details','reroute','carrier_profile'));

-- Voiding a schedule that was already handed to the factor does not free its
-- loads until a person confirms the factor has not advanced against them.
ALTER TABLE factoring_batches
  ADD COLUMN loads_released_at timestamptz,
  ADD COLUMN loads_released_by uuid REFERENCES users;

-- Who cancelled the order. TONU is owed only when the payer cancelled.
ALTER TABLE loads
  ADD COLUMN cancel_party text CHECK(cancel_party IN ('payer','carrier','dispatch','other'));
