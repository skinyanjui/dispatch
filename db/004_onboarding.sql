CREATE TABLE carrier_profiles (
  carrier_id uuid PRIMARY KEY REFERENCES carriers,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  phone text NOT NULL DEFAULT '',
  usdot text NOT NULL DEFAULT '',
  step text NOT NULL DEFAULT 'agreement' CHECK(step IN ('agreement','team','complete')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drivers ADD COLUMN onboarding_status text NOT NULL DEFAULT 'ready' CHECK(onboarding_status IN ('pending','ready'));
ALTER TABLE drivers ADD COLUMN contact_email text;
ALTER TABLE drivers ADD COLUMN phone text NOT NULL DEFAULT '';
ALTER TABLE drivers ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE carrier_dispatch_authorizations ADD COLUMN verified_by uuid REFERENCES users;

CREATE TABLE onboarding_invites (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  driver_id uuid,
  role text NOT NULL CHECK(role IN ('carrier-manager','driver')),
  email text NOT NULL,
  name text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users,
  CHECK((role='driver')=(driver_id IS NOT NULL)),
  CHECK((accepted_at IS NULL)=(accepted_by IS NULL)),
  FOREIGN KEY(driver_id,carrier_id) REFERENCES drivers(id,carrier_id)
);
CREATE INDEX onboarding_invite_carrier ON onboarding_invites(carrier_id,created_at DESC);
CREATE TABLE onboarding_requests (
  actor_id uuid REFERENCES users,
  key uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY(actor_id,key)
);
CREATE TABLE onboarding_events (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  actor_id uuid NOT NULL REFERENCES users,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_onboarding_events BEFORE UPDATE OR DELETE ON onboarding_events
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
ALTER TABLE outbox_events ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE outbox_events ADD COLUMN onboarding_event_id uuid REFERENCES onboarding_events;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_event_source CHECK(num_nonnulls(event_id,onboarding_event_id)=1);
