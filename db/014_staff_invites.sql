-- Dispatcher and organization-admin invitations (ADR 0016). Staff invitations
-- belong to an organization, not one carrier, so they live apart from the
-- carrier-bound onboarding_invites.
CREATE TABLE staff_invites (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  role text NOT NULL CHECK(role IN ('dispatcher','admin')),
  -- Carriers the person will dispatch for (verified against the organization
  -- when created and again when accepted).
  carrier_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text UNIQUE NOT NULL,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users,
  CHECK(role<>'dispatcher' OR cardinality(carrier_ids)>0),
  CHECK((accepted_at IS NULL)=(accepted_by IS NULL))
);
CREATE INDEX staff_invites_by_org ON staff_invites(organization_id,created_at DESC);

-- A phone number on the account lets teammates and drivers reach each other
-- (contacts directory) without a separate profile table.
ALTER TABLE users ADD COLUMN phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40);

CREATE TABLE organization_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  actor_id uuid NOT NULL REFERENCES users,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_organization_events BEFORE UPDATE OR DELETE ON organization_events
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
