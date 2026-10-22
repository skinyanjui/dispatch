-- Fleet: vehicles become real records (ADR 0048). Expand only. The table has
-- existed since migration 001 but nothing wrote to it, so these additions all
-- have defaults and no data is rewritten.
-- Rollback: DROP INDEX vehicles_label_unique; then drop the added columns.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM vehicles WHERE length(label) NOT BETWEEN 1 AND 60) THEN
    RAISE EXCEPTION 'vehicles has labels outside 1-60 characters; fix them before migrating';
  END IF;
  IF EXISTS(SELECT 1 FROM vehicles GROUP BY carrier_id,lower(label) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'vehicles has duplicate labels within a carrier; fix them before migrating';
  END IF;
END $$;
ALTER TABLE vehicles
  ADD COLUMN kind text NOT NULL DEFAULT 'other'
    CHECK(kind IN ('tractor','straight_truck','box_truck','cargo_van','sprinter_van','trailer','other')),
  ADD COLUMN plate text NOT NULL DEFAULT '' CHECK(length(plate)<=20),
  ADD COLUMN vin text NOT NULL DEFAULT '' CHECK(vin='' OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT vehicles_label_length CHECK(length(label) BETWEEN 1 AND 60);
CREATE UNIQUE INDEX vehicles_label_unique ON vehicles(carrier_id,lower(label));
CREATE INDEX vehicles_by_carrier ON vehicles(carrier_id,status,label);
