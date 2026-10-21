-- Durable email outbox. Bodies are AES-GCM ciphertext (they can contain
-- invitation and reset links) and are purged after delivery. Recipients and
-- subjects stay for the delivery log; no message content is kept afterwards.
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations,
  recipient_user_id uuid REFERENCES users,
  recipient_email text NOT NULL CHECK(length(recipient_email) BETWEEN 3 AND 254),
  kind text NOT NULL CHECK(kind IN ('invitation','password_reset','email_verification',
    'assignment','exception_assigned','document_reminder','insurance_reminder','exception_overdue')),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  body_ciphertext text,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text CHECK(length(last_error)<=300),
  provider text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK(status<>'pending' OR body_ciphertext IS NOT NULL)
);
CREATE INDEX notification_due ON notifications(next_attempt_at) WHERE status='pending';
CREATE INDEX notification_log ON notifications(organization_id,created_at DESC);

-- Only operational kinds can be muted; security and invitation emails cannot.
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL CHECK(kind IN ('assignment','exception_assigned','document_reminder','insurance_reminder','exception_overdue')),
  email boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,kind)
);
