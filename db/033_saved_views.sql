-- Saved views of the Loads page (ADR 0038). Expand-only: one new table.
-- A view stores only display choices (layout, grouping, sort, visible fields,
-- filters); it never stores or grants access to records. A shared view is
-- visible to members of the owner's organization; only the owner changes it.
-- Rollback: leave the table; code that ignores it behaves as before.
CREATE TABLE saved_views (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users,
  organization_id uuid REFERENCES organizations,
  surface text NOT NULL CHECK(surface IN ('loads')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
  shared boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,surface,name),
  CHECK(NOT shared OR organization_id IS NOT NULL)
);
CREATE INDEX saved_views_by_org ON saved_views(organization_id) WHERE shared;
