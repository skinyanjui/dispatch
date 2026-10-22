-- Document templates and drafts (ADR 0040). Expand-only: two new tables.
-- A template is text with {{merge fields}}. A draft is that text filled in
-- from one load, carrier or contact. Drafts are for a person to review and
-- copy: nothing is sent, booked, invoiced or stored as a load document.
-- The rendered text never changes; only its review status does.
-- Rollback: leave the tables; code that ignores them behaves as before.
CREATE TABLE document_templates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  target text NOT NULL CHECK(target IN ('load','carrier','contact')),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX document_templates_name ON document_templates(organization_id,lower(name)) WHERE archived_at IS NULL;
CREATE TABLE document_drafts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  template_id uuid NOT NULL REFERENCES document_templates,
  template_name text NOT NULL,
  target text NOT NULL CHECK(target IN ('load','carrier','contact')),
  target_id uuid NOT NULL,
  target_label text NOT NULL,
  body text NOT NULL,
  missing text[] NOT NULL DEFAULT '{}',
  source text NOT NULL CHECK(source IN ('person','assistant')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','discarded')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users,
  decided_at timestamptz,
  idempotency_key uuid NOT NULL,
  UNIQUE(created_by,idempotency_key),
  CHECK((status='draft')=(decided_at IS NULL))
);
CREATE INDEX document_drafts_by_org ON document_drafts(organization_id,created_at DESC,id DESC);
CREATE INDEX document_drafts_by_target ON document_drafts(target,target_id);
CREATE FUNCTION document_draft_body_is_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'draft text is fixed once generated';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER document_draft_fixed BEFORE UPDATE ON document_drafts
  FOR EACH ROW EXECUTE FUNCTION document_draft_body_is_fixed();
