-- Scheduled job runs (ADR 0046). Expand only: a new table that only the job
-- runner and the status view read or write. Rollback: DROP TABLE job_runs.
CREATE TABLE job_runs (
  id uuid PRIMARY KEY,
  job text NOT NULL CHECK(job IN ('notifications')),
  scope text NOT NULL CHECK(scope IN ('tick','daily')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK(outcome IN ('running','ok','error')),
  -- Counts on success, a short error message on failure. Never record text.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer CHECK(duration_ms IS NULL OR duration_ms>=0),
  CHECK((outcome='running')=(finished_at IS NULL))
);
CREATE INDEX job_runs_recent ON job_runs(job,scope,started_at DESC);
