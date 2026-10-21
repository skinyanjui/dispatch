-- Account security
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_secret_ciphertext text;
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
-- Last accepted TOTP time step; a code can be used at most once.
ALTER TABLE users ADD COLUMN mfa_last_step bigint;
ALTER TABLE users ADD CONSTRAINT mfa_enabled_has_secret
  CHECK(mfa_enabled_at IS NULL OR mfa_secret_ciphertext IS NOT NULL);
-- Backfill: accepting an emailed invitation link proved control of the address.
UPDATE users u SET email_verified_at=i.accepted_at
  FROM onboarding_invites i WHERE i.accepted_by=u.id AND u.email_verified_at IS NULL;

CREATE TABLE account_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users,
  purpose text NOT NULL CHECK(purpose IN ('password_reset','email_verification')),
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX account_tokens_by_user ON account_tokens(user_id,purpose) WHERE used_at IS NULL;
CREATE TABLE mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES users,
  code_hash text NOT NULL,
  used_at timestamptz,
  PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
);

-- Tenancy: explicit organization administrators (ADR 0011). Previously the
-- organization was implied by dispatcher memberships of its carriers.
CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations,
  user_id uuid NOT NULL REFERENCES users,
  role text NOT NULL CHECK(role IN ('owner','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id)
);
INSERT INTO organization_members(organization_id,user_id,role)
  SELECT DISTINCT c.organization_id,m.user_id,'admin'
  FROM memberships m JOIN carriers c ON c.id=m.carrier_id WHERE m.role='dispatcher'
  ON CONFLICT DO NOTHING;
CREATE TABLE organization_profiles (
  organization_id uuid PRIMARY KEY REFERENCES organizations,
  legal_name text NOT NULL DEFAULT '' CHECK(length(legal_name)<=200),
  billing_email text NOT NULL DEFAULT '' CHECK(length(billing_email)<=254),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
  address text NOT NULL DEFAULT '' CHECK(length(address)<=500),
  timezone text NOT NULL DEFAULT 'America/Chicago',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Team removal keeps the driver's history but takes them off the roster.
ALTER TABLE drivers DROP CONSTRAINT drivers_onboarding_status_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_onboarding_status_check
  CHECK(onboarding_status IN ('pending','ready','removed'));
CREATE TABLE membership_removals (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  user_id uuid REFERENCES users,
  driver_id uuid REFERENCES drivers,
  role text NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  removed_by uuid NOT NULL REFERENCES users,
  removed_at timestamptz NOT NULL DEFAULT now(),
  CHECK(num_nonnulls(user_id,driver_id)>=1)
);
CREATE TRIGGER immutable_membership_removals BEFORE UPDATE OR DELETE ON membership_removals
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
