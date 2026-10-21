-- Shared between all application instances. Store only a hash of the login identity.
CREATE TABLE login_attempts (
  identity_hash text PRIMARY KEY,
  attempts integer NOT NULL CHECK(attempts > 0),
  resets_at timestamptz NOT NULL
);
CREATE INDEX login_attempts_expiry ON login_attempts(resets_at);
CREATE INDEX session_expiry ON sessions(expires_at);
