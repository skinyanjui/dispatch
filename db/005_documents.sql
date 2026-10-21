-- Versioned carrier and load documents. A document is a slot (carrier-level
-- compliance file or a load paperwork type); every upload is an immutable
-- version and every review decision is an append-only record. Current status
-- is derived from the latest version and its latest review.
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  load_id uuid,
  type text NOT NULL CHECK(type IN (
    'dispatch_agreement','insurance_auto_liability','insurance_cargo','w9',
    'rate_confirmation','bol','pod')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((load_id IS NULL) = (type IN ('dispatch_agreement','insurance_auto_liability','insurance_cargo','w9'))),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(id,carrier_id)
);
CREATE UNIQUE INDEX document_carrier_slot ON documents(carrier_id,type) WHERE load_id IS NULL;
CREATE UNIQUE INDEX document_load_slot ON documents(load_id,type) WHERE load_id IS NOT NULL;

-- Bytes live behind a storage key so the Postgres store can be replaced by
-- object storage without changing version records.
CREATE TABLE document_objects (
  storage_key text PRIMARY KEY,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/png','image/jpeg')),
  size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=4194304),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL UNIQUE REFERENCES document_objects,
  expires_on date,
  uploaded_by uuid NOT NULL REFERENCES users,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY(document_id,carrier_id) REFERENCES documents(id,carrier_id),
  UNIQUE(document_id,version),
  UNIQUE(uploaded_by,idempotency_key),
  UNIQUE(id,carrier_id)
);

CREATE TABLE document_reviews (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES users,
  decision text NOT NULL CHECK(decision IN ('accepted','rejected')),
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(decision='accepted' OR length(note)>0),
  FOREIGN KEY(version_id,carrier_id) REFERENCES document_versions(id,carrier_id)
);
CREATE INDEX document_review_history ON document_reviews(version_id,created_at DESC,id DESC);
CREATE INDEX document_version_history ON document_versions(document_id,version DESC);

CREATE TRIGGER immutable_document_objects BEFORE UPDATE OR DELETE ON document_objects
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
CREATE TRIGGER immutable_document_versions BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
CREATE TRIGGER immutable_document_reviews BEFORE UPDATE OR DELETE ON document_reviews
  FOR EACH ROW EXECUTE FUNCTION immutable_event();

-- Expand: existing authorizations keep a reference only (NULL). New reviews may
-- link the exact agreement file version that was verified.
ALTER TABLE carrier_dispatch_authorizations
  ADD COLUMN document_version_id uuid REFERENCES document_versions;
