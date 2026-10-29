-- Follow-ups to the money-controls audit (ADR 0071). Expand-only.
-- Rollback: leave the columns and the wider checks; code that ignores them
-- behaves as before.

-- Approvers are told when a sensitive change waits for them.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN (
  'invitation','password_reset','email_verification','assignment','exception_assigned',
  'document_reminder','insurance_reminder','exception_overdue','message','message_received',
  'appointment_reminder','approval_request'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check CHECK(kind IN (
  'assignment','exception_assigned','document_reminder','insurance_reminder','exception_overdue',
  'message_received','appointment_reminder','approval_request'));

-- The carrier's MC (docket) number, which sold or hijacked registrations change.
ALTER TABLE carrier_profiles
  ADD COLUMN mc_number text NOT NULL DEFAULT '' CHECK(mc_number ~ '^[0-9]{0,8}$');

-- What a lookup found about the MC number and about insurance amounts.
ALTER TABLE carrier_authority_checks
  ADD COLUMN mc_number text NOT NULL DEFAULT '' CHECK(mc_number ~ '^[0-9]{0,8}$'),
  ADD COLUMN mc_outcome text NOT NULL DEFAULT 'not_checked'
    CHECK(mc_outcome IN ('not_checked','matches','different_carrier','not_found')),
  -- Some insurance is on file but less than the registry says is required.
  ADD COLUMN insurance_shortfall boolean;

-- Terms point at the rate confirmation file they came from.
ALTER TABLE detention_terms
  ADD COLUMN document_version_id uuid REFERENCES document_versions;
