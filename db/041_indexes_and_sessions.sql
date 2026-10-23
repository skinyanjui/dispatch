-- Backend audit 2026-10-23. EXPAND only; nothing is dropped or rewritten.
-- 1) Indexes for foreign keys that request-time lookups and cleanup deletes
--    filter by (each was a sequential scan). Plain CREATE INDEX because
--    migrations run in one transaction; the tables take a brief write lock.
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS mfa_challenges_by_user ON mfa_challenges(user_id);
CREATE INDEX IF NOT EXISTS account_tokens_by_user ON account_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS memberships_by_carrier ON memberships(carrier_id, role);
CREATE INDEX IF NOT EXISTS organization_members_by_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS drivers_by_carrier ON drivers(carrier_id);
CREATE INDEX IF NOT EXISTS notifications_by_recipient ON notifications(recipient_user_id, created_at DESC) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_by_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS thread_reads_by_user ON thread_reads(user_id);
CREATE INDEX IF NOT EXISTS prospects_by_carrier ON prospects(carrier_id) WHERE carrier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_by_owner ON prospects(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stop_events_by_load ON stop_events(load_id, stop_id);
-- 2) Sessions get a public id and a start time so a person can see and end them.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(id);
-- ROLLBACK (manual): DROP the indexes above; ALTER TABLE sessions DROP COLUMN id, DROP COLUMN created_at.
