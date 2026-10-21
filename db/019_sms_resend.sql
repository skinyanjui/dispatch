-- Resending a failed text (ADR 0021): count attempts so a double click or two
-- people cannot send the same retry twice.
ALTER TABLE message_deliveries ADD COLUMN attempts integer NOT NULL DEFAULT 1 CHECK(attempts>=1);
