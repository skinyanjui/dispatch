CREATE TABLE provider_receipts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK(provider IN ('twilio','resend')),
  event_id text NOT NULL,
  provider_message_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('delivered','failed')),
  notification_id uuid REFERENCES notifications,
  delivery_id uuid REFERENCES message_deliveries,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK(num_nonnulls(notification_id,delivery_id)<=1),
  UNIQUE(provider,event_id)
);
CREATE INDEX provider_receipts_notification ON provider_receipts(notification_id,status);
CREATE INDEX provider_receipts_message ON provider_receipts(provider,provider_message_id,status);
CREATE INDEX provider_receipts_delivery ON provider_receipts(delivery_id,status);
CREATE INDEX notification_provider_message ON notifications(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX delivery_provider_message ON message_deliveries(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TRIGGER immutable_provider_receipts BEFORE UPDATE OR DELETE ON provider_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
