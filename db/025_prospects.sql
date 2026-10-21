-- Prospects: prospective carrier clients the dispatch company is courting
-- (ADR 0030). Expand-only: two new tables, no change to existing rows.
-- Rollback: leave the tables in place; code that ignores them behaves as
-- before. A prospect is not a carrier and has no access to anything; becoming
-- a carrier is a separate, explicit step that creates a carrier setup record.
CREATE TABLE prospects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  company text NOT NULL CHECK(length(company) BETWEEN 1 AND 160),
  contact_name text NOT NULL DEFAULT '' CHECK(length(contact_name)<=160),
  email text NOT NULL DEFAULT '' CHECK(length(email)<=254),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
  usdot text NOT NULL DEFAULT '' CHECK(length(usdot)<=20),
  truck_count integer CHECK(truck_count BETWEEN 0 AND 100000),
  source text NOT NULL DEFAULT 'other'
    CHECK(source IN ('referral','inbound','load_board','cold_outreach','event','other')),
  stage text NOT NULL DEFAULT 'new'
    CHECK(stage IN ('new','contacted','qualified','proposal','won','lost')),
  lost_reason text NOT NULL DEFAULT '' CHECK(length(lost_reason)<=300),
  owner_id uuid REFERENCES users,
  next_follow_up_on date,
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=2000),
  -- Set once when the prospect is turned into a carrier setup record.
  carrier_id uuid REFERENCES carriers,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK(stage<>'lost' OR lost_reason<>''),
  CHECK(carrier_id IS NULL OR stage='won'),
  UNIQUE(created_by,idempotency_key)
);
CREATE INDEX prospects_by_org ON prospects(organization_id,archived_at,stage);
CREATE INDEX prospects_follow_up ON prospects(organization_id,next_follow_up_on)
  WHERE archived_at IS NULL AND next_follow_up_on IS NOT NULL;

-- Notes, calls and stage changes. Append-only: the history of a relationship
-- is evidence, so corrections are new entries.
CREATE TABLE prospect_activities (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects,
  organization_id uuid NOT NULL REFERENCES organizations,
  kind text NOT NULL CHECK(kind IN ('note','call','email','meeting','stage','converted')),
  body text NOT NULL DEFAULT '' CHECK(length(body)<=2000),
  actor_id uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid,
  request_hash text,
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX prospect_activities_by_prospect ON prospect_activities(prospect_id,created_at DESC);
CREATE TRIGGER immutable_prospect_activities BEFORE UPDATE OR DELETE ON prospect_activities
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
