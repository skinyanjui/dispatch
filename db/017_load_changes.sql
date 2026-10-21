-- Load edits and cancellation (ADR 0019). Expand-only: new nullable columns and
-- an append-only change log. Rollback: leave the columns in place; code that
-- ignores them behaves as before.
ALTER TABLE loads
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid REFERENCES users,
  ADD COLUMN cancel_reason text CHECK(length(cancel_reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT loads_cancellation_complete CHECK(
    (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
    OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL));
CREATE INDEX loads_cancelled ON loads(carrier_id,cancelled_at DESC) WHERE cancelled_at IS NOT NULL;

-- One row per changed field. change_group ties together fields saved in one edit.
CREATE TABLE load_changes (
  id uuid PRIMARY KEY,
  change_group uuid NOT NULL,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users,
  stop_id uuid REFERENCES load_stops,
  field text NOT NULL CHECK(field IN ('reference','source','amount_minor','address','timezone','window_start','window_end')),
  old_value text NOT NULL,
  new_value text NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id)
);
CREATE INDEX load_changes_by_load ON load_changes(load_id,created_at DESC);
CREATE TRIGGER immutable_load_changes BEFORE UPDATE OR DELETE ON load_changes FOR EACH ROW EXECUTE FUNCTION immutable_event();
