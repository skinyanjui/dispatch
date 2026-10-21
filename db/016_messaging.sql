-- Inbox: conversations, messages sent by Relay or logged by hand, delivery
-- status, read state and saved replies (ADR 0018).
CREATE TABLE threads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  carrier_id uuid REFERENCES carriers,
  load_id uuid,
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  CHECK(load_id IS NULL OR carrier_id IS NOT NULL)
);
CREATE INDEX threads_recent ON threads(organization_id,last_message_at DESC,id DESC);
CREATE INDEX threads_by_load ON threads(load_id) WHERE load_id IS NOT NULL;
CREATE INDEX threads_by_carrier ON threads(carrier_id,last_message_at DESC) WHERE carrier_id IS NOT NULL;

-- Participants keep the directory key and a snapshot of how to reach them, so
-- history stays readable after a contact changes or is archived.
CREATE TABLE thread_participants (
  thread_id uuid NOT NULL REFERENCES threads,
  participant_key text NOT NULL CHECK(length(participant_key) BETWEEN 8 AND 60),
  user_id uuid REFERENCES users,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(thread_id,participant_key)
);
CREATE INDEX thread_participants_by_user ON thread_participants(user_id,thread_id) WHERE user_id IS NOT NULL;

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES threads,
  sender_user_id uuid NOT NULL REFERENCES users,
  channel text NOT NULL CHECK(channel IN ('in_app','email','sms','call')),
  direction text NOT NULL CHECK(direction IN ('out','in')),
  -- relay: sent by Relay. logged: recorded by hand (sent or received elsewhere).
  source text NOT NULL CHECK(source IN ('relay','logged')),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
  -- For logged inbound messages: who it was from.
  counterpart text NOT NULL DEFAULT '' CHECK(length(counterpart)<=160),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK(source='logged' OR (direction='out' AND channel<>'call')),
  UNIQUE(sender_user_id,idempotency_key)
);
CREATE INDEX messages_by_thread ON messages(thread_id,occurred_at DESC,id DESC);

CREATE TABLE message_deliveries (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages,
  participant_key text NOT NULL,
  channel text NOT NULL CHECK(channel IN ('in_app','email','sms')),
  address text NOT NULL DEFAULT '',
  -- email deliveries take their status from the linked notification.
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','sent','failed','unknown')),
  notification_id uuid REFERENCES notifications,
  provider_message_id text,
  last_error text CHECK(length(last_error)<=300),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_deliveries_by_message ON message_deliveries(message_id);

CREATE TABLE thread_reads (
  thread_id uuid NOT NULL REFERENCES threads,
  user_id uuid NOT NULL REFERENCES users,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(thread_id,user_id)
);

CREATE TABLE saved_replies (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations,
  owner_id uuid NOT NULL REFERENCES users,
  -- Shared replies belong to an organization; personal ones only to the owner.
  shared boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(shared=(organization_id IS NOT NULL))
);
CREATE INDEX saved_replies_by_owner ON saved_replies(owner_id);
CREATE INDEX saved_replies_by_org ON saved_replies(organization_id) WHERE shared;

-- Text-message consent. People consent for their own account; for external
-- contacts a dispatcher records that the contact agreed, with a note.
ALTER TABLE users ADD COLUMN sms_opt_in_at timestamptz;
ALTER TABLE contacts ADD COLUMN sms_consent_at timestamptz;
ALTER TABLE contacts ADD COLUMN sms_consent_by uuid REFERENCES users;
ALTER TABLE contacts ADD COLUMN sms_consent_note text NOT NULL DEFAULT '' CHECK(length(sms_consent_note)<=300);
ALTER TABLE contacts ADD CONSTRAINT contacts_sms_consent_pair
  CHECK((sms_consent_at IS NULL)=(sms_consent_by IS NULL));

-- Notifications: user-sent emails, in-app message alerts, and a reply-to.
ALTER TABLE notifications ADD COLUMN reply_to text CHECK(length(reply_to)<=254);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN (
  'invitation','password_reset','email_verification','assignment','exception_assigned',
  'document_reminder','insurance_reminder','exception_overdue','message','message_received'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check CHECK(kind IN (
  'assignment','exception_assigned','document_reminder','insurance_reminder','exception_overdue','message_received'));
