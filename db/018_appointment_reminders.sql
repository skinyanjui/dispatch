-- Appointment reminders to drivers (ADR 0020): one more notification kind.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN (
  'invitation','password_reset','email_verification','assignment','exception_assigned',
  'document_reminder','insurance_reminder','exception_overdue','message','message_received',
  'appointment_reminder'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check CHECK(kind IN (
  'assignment','exception_assigned','document_reminder','insurance_reminder','exception_overdue','message_received',
  'appointment_reminder'));
