-- Google and Apple sign-in (ADR 0034). Expand-only: two new tables.
-- external_identities links a provider account to one Relay user.
-- oidc_states holds one in-flight sign-in (state, nonce, PKCE verifier) so a
-- callback can be used once and only by the browser that started it.
-- Rollback: leave the tables; code that ignores them behaves as before.
CREATE TABLE external_identities (
  provider text NOT NULL CHECK(provider IN ('google','apple')),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_at_link text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,subject)
);
CREATE INDEX external_identities_user_idx ON external_identities(user_id);
CREATE TABLE oidc_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL CHECK(provider IN ('google','apple')),
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  remember boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);
