-- External contacts (brokers, shippers, receivers, facilities) and per-user
-- favorites. Team members, drivers and carriers are already records; the
-- directory reads them in place rather than copying them (ADR 0017).
CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  -- Optional link to the carrier this contact is relevant to. Carrier
  -- managers see only contacts linked to their own carrier.
  carrier_id uuid REFERENCES carriers,
  kind text NOT NULL CHECK(kind IN ('broker','shipper','receiver','facility','vendor','other')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  company text NOT NULL DEFAULT '' CHECK(length(company)<=160),
  email text NOT NULL DEFAULT '' CHECK(length(email)<=254),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK(email<>'' OR phone<>''),
  UNIQUE(created_by,idempotency_key)
);
CREATE INDEX contacts_by_org ON contacts(organization_id,archived_at,lower(name));
CREATE INDEX contacts_by_carrier ON contacts(carrier_id) WHERE carrier_id IS NOT NULL;

-- ref_key is 'user:<id>', 'driver:<id>', 'carrier:<id>' or 'contact:<id>'.
CREATE TABLE contact_favorites (
  user_id uuid NOT NULL REFERENCES users,
  ref_key text NOT NULL CHECK(length(ref_key) BETWEEN 8 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,ref_key)
);
