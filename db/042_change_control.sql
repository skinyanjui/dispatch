-- Change control for the details fraudsters change (ADR 0064). Expand-only: two
-- new tables, no change to existing rows. Rollback: leave the tables in place;
-- code that ignores them behaves as before, except that the guarded edits
-- (carrier contact phone/email, stop address after dispatch) would be applied
-- directly again.
--
-- A sensitive change is requested by one person and applied only when a
-- different person, who works for the carrier or administers the organization,
-- approves it after checking it another way than the request itself.
CREATE TABLE sensitive_changes (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  kind text NOT NULL CHECK(kind IN ('payout_details','contact_details','reroute')),
  subject_id uuid,
  summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 300),
  current_value jsonb NOT NULL,
  proposed_value jsonb NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  requested_by uuid NOT NULL REFERENCES users,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','stale')),
  decided_by uuid REFERENCES users,
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '' CHECK(length(decision_note)<=500),
  -- How the approver confirmed it without using the request's own contact path.
  verification text CHECK(verification IN ('callback','document','in_person')),
  effective_at timestamptz,
  CHECK((status='pending')=(decided_by IS NULL)),
  CHECK((status='pending')=(decided_at IS NULL)),
  -- Separation of duties is enforced by the database, not only by the handler.
  CHECK(status IN ('pending','cancelled') OR decided_by<>requested_by),
  CHECK(status<>'approved' OR (verification IS NOT NULL AND effective_at IS NOT NULL))
);
CREATE UNIQUE INDEX sensitive_changes_one_pending
  ON sensitive_changes(carrier_id,kind,COALESCE(subject_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status='pending';
CREATE INDEX sensitive_changes_by_carrier ON sensitive_changes(carrier_id,requested_at DESC);

-- The carrier's current remit-to instructions. Relay never holds freight
-- proceeds and stores no full account number: payee, method and last four
-- digits identify the account for a human who then confirms it by phone.
CREATE TABLE carrier_payout_details (
  carrier_id uuid PRIMARY KEY REFERENCES carriers,
  payee_name text NOT NULL CHECK(length(payee_name) BETWEEN 1 AND 160),
  method text NOT NULL CHECK(method IN ('ach','wire','check','factor')),
  account_last4 text NOT NULL DEFAULT '' CHECK(account_last4='' OR account_last4 ~ '^[0-9]{4}$'),
  effective_at timestamptz NOT NULL,
  change_id uuid REFERENCES sensitive_changes,
  updated_at timestamptz NOT NULL DEFAULT now()
);
