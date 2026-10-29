-- Dispatchers hear when a carrier's public registration turns to "attention"
-- (ADR 0072). Expand-only. Rollback: leave the wider checks; code that does not
-- send the kind behaves as before.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN (
  'invitation','password_reset','email_verification','assignment','exception_assigned',
  'document_reminder','insurance_reminder','exception_overdue','message','message_received',
  'appointment_reminder','approval_request','registration_alert'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check CHECK(kind IN (
  'assignment','exception_assigned','document_reminder','insurance_reminder','exception_overdue',
  'message_received','appointment_reminder','approval_request','registration_alert'));
