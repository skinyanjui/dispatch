-- Inbound email and text (ADR 0023). Messages received from outside have no
-- Relay sender, carry the provider's message id for de-duplication, and a
-- label for who sent them.
ALTER TABLE messages ALTER COLUMN sender_user_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN sender_label text NOT NULL DEFAULT '' CHECK(length(sender_label)<=160);
ALTER TABLE messages ADD COLUMN external_id text CHECK(length(external_id) BETWEEN 1 AND 200);
ALTER TABLE messages DROP CONSTRAINT messages_source_check;
ALTER TABLE messages ADD CONSTRAINT messages_source_check CHECK(source IN ('relay','logged','inbound'));
ALTER TABLE messages DROP CONSTRAINT messages_check;
ALTER TABLE messages ADD CONSTRAINT messages_origin_check CHECK(
  (source='inbound' AND sender_user_id IS NULL AND direction='in' AND external_id IS NOT NULL AND channel IN ('email','sms'))
  OR (source IN ('relay','logged') AND sender_user_id IS NOT NULL));
ALTER TABLE messages ADD CONSTRAINT messages_relay_outgoing_check CHECK(
  source<>'relay' OR (direction='out' AND channel<>'call'));
-- A provider message id is accepted once, whatever the thread.
CREATE UNIQUE INDEX messages_external_once ON messages(channel,external_id) WHERE external_id IS NOT NULL;
