-- Operational alerts (docs/runbooks/alerting.md). One row per alert condition
-- records what was last sent so a standing problem is announced once a day, not
-- every 15 minutes. EXPAND only: nothing reads it until RELAY_ALERT_WEBHOOK_URL
-- is set. ROLLBACK (manual): DROP TABLE alert_state;
CREATE TABLE alert_state (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);
