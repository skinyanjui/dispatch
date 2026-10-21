-- "Keep me signed in" (ADR 0034). Expand-only: two boolean columns that default
-- to false, so every existing session and challenge keeps its behaviour.
-- Rollback: leave the columns; code that ignores them behaves as before.
ALTER TABLE sessions ADD COLUMN remember boolean NOT NULL DEFAULT false;
ALTER TABLE mfa_challenges ADD COLUMN remember boolean NOT NULL DEFAULT false;
