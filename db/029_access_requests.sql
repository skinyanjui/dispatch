-- Request access (ADR 0034). Expand-only: one new table. A request creates no
-- account, organization or session; an operator approves or declines it.
-- Rollback: leave the table; code that ignores it behaves as before.
CREATE TABLE access_requests (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(email)),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  company text NOT NULL CHECK(length(company) BETWEEN 1 AND 160),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
  -- 'form' is the public page; 'google' and 'apple' are people who signed in
  -- with a provider that has no Relay account yet (the email is verified).
  source text NOT NULL CHECK(source IN ('form','google','apple')),
  email_verified boolean NOT NULL DEFAULT false,
  -- Which version of the Terms and Privacy pages was shown and accepted.
  terms_version text,
  terms_accepted_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  decision_note text NOT NULL DEFAULT '' CHECK(length(decision_note)<=300),
  decided_at timestamptz,
  organization_id uuid REFERENCES organizations,
  user_id uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((source='form')=(terms_accepted_at IS NOT NULL)),
  CHECK((status='pending')=(decided_at IS NULL)),
  CHECK(status<>'approved' OR organization_id IS NOT NULL)
);
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests(email) WHERE status='pending';
CREATE INDEX access_requests_by_status ON access_requests(status,created_at);
