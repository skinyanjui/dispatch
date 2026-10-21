-- Direct-to-bucket uploads (ADR 0015). A session reserves a quarantine key
-- for one declared file; nothing becomes a document version until the
-- server has re-read, verified and scanned the uploaded bytes.
ALTER TABLE document_versions DROP CONSTRAINT document_versions_size_bytes_check;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_size_bytes_check
  CHECK(size_bytes>0 AND size_bytes<=26214400);

CREATE TABLE document_upload_sessions (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users,
  carrier_id uuid NOT NULL REFERENCES carriers,
  load_id uuid,
  type text NOT NULL,
  expires_on date,
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=26214400),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  bucket text NOT NULL,
  quarantine_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','finalized','rejected')),
  failure text CHECK(length(failure)<=100),
  version_id uuid REFERENCES document_versions,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK((status='finalized')=(version_id IS NOT NULL)),
  CHECK((status='rejected')=(failure IS NOT NULL)),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX document_upload_sessions_pending ON document_upload_sessions(expires_at) WHERE status='pending';
