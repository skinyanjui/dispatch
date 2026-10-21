-- Per-person conversation state (ADR 0035). Expand-only: one new table.
-- Archive and trash hide a conversation from one person's inbox only; no
-- message is changed or deleted. A conversation counts as archived or trashed
-- only while its last message is not newer than the timestamp, so a new
-- message brings it back without any write.
-- Rollback: leave the table; code that ignores it behaves as before.
CREATE TABLE thread_states (
  thread_id uuid NOT NULL REFERENCES threads,
  user_id uuid NOT NULL REFERENCES users,
  archived_at timestamptz,
  trashed_at timestamptz,
  marked_unread_at timestamptz,
  PRIMARY KEY(thread_id,user_id)
);
CREATE INDEX thread_states_by_user ON thread_states(user_id);
