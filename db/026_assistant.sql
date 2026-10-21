-- Dispatch assistant (ADR 0031): a read-only chat agent over the signed-in
-- person's own loads, exceptions, billing, prospects, contacts and carriers.
-- Expand-only: one new column (off by default) and two new tables. Rollback:
-- leave them; code that ignores them behaves as before.
ALTER TABLE organization_ai_settings
  ADD COLUMN assistant_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  user_id uuid NOT NULL REFERENCES users,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_by_user ON assistant_conversations(user_id,updated_at DESC);

-- One row per question. tools records which tools ran and the records they
-- returned (names and references only), which is the provenance shown as
-- "Sources"; the model cannot add to it. Costs are integer micro-dollars.
CREATE TABLE assistant_turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations,
  organization_id uuid NOT NULL REFERENCES organizations,
  user_id uuid NOT NULL REFERENCES users,
  question text NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
  answer text,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
  error_code text,
  tools jsonb NOT NULL DEFAULT '[]',
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens integer CHECK(input_tokens>=0),
  output_tokens integer CHECK(output_tokens>=0),
  reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
  cost_micros bigint CHECK(cost_micros>=0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX assistant_turns_by_conversation ON assistant_turns(conversation_id,created_at);
CREATE INDEX assistant_turns_spend ON assistant_turns(organization_id,created_at);
