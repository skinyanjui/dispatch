-- Two independent financial lifecycles. Carrier freight billing belongs to the
-- carrier (Relay prepares the packet and records receipts the carrier reports;
-- it never holds freight proceeds). Dispatch-service invoices are Relay's own
-- fee invoices to the carrier. Money is integer cents.
CREATE TABLE carrier_billing_packets (
  load_id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL,
  bill_to text NOT NULL CHECK(length(bill_to) BETWEEN 1 AND 200),
  carrier_invoice_number text NOT NULL CHECK(length(carrier_invoice_number) BETWEEN 1 AND 60),
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
  submitted_at timestamptz,
  submitted_by uuid REFERENCES users,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  CHECK((status='submitted')=(submitted_at IS NOT NULL AND submitted_by IS NOT NULL)),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id),
  UNIQUE(load_id,carrier_id)
);
CREATE TABLE carrier_payment_receipts (
  id uuid PRIMARY KEY,
  load_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  received_on date NOT NULL,
  reference text NOT NULL DEFAULT '' CHECK(length(reference)<=100),
  recorded_by uuid NOT NULL REFERENCES users,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY(load_id,carrier_id) REFERENCES carrier_billing_packets(load_id,carrier_id),
  UNIQUE(recorded_by,idempotency_key)
);
CREATE INDEX carrier_receipts_by_load ON carrier_payment_receipts(load_id,received_on);

CREATE SEQUENCE dispatch_invoice_number START 1001;
CREATE TABLE dispatch_invoices (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL REFERENCES carriers,
  number text UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','void')),
  fee_bps integer NOT NULL CHECK(fee_bps BETWEEN 0 AND 10000),
  total_minor bigint NOT NULL CHECK(total_minor>=0 AND total_minor<=9007199254740991),
  due_on date NOT NULL,
  issued_at timestamptz,
  issued_by uuid REFERENCES users,
  voided_at timestamptz,
  voided_by uuid REFERENCES users,
  void_reason text CHECK(length(void_reason) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  CHECK((issued_at IS NULL)=(number IS NULL)),
  CHECK(status<>'issued' OR issued_at IS NOT NULL),
  CHECK((status='void')=(voided_at IS NOT NULL)),
  UNIQUE(created_by,idempotency_key),
  UNIQUE(id,carrier_id)
);
CREATE INDEX dispatch_invoices_by_carrier ON dispatch_invoices(carrier_id,created_at DESC);
CREATE TABLE dispatch_invoice_lines (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  load_id uuid NOT NULL,
  load_amount_minor bigint NOT NULL CHECK(load_amount_minor>=0),
  fee_minor bigint NOT NULL CHECK(fee_minor>=0),
  -- Cleared only when the invoice is voided, releasing the load for billing.
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY(invoice_id,carrier_id) REFERENCES dispatch_invoices(id,carrier_id),
  FOREIGN KEY(load_id,carrier_id) REFERENCES loads(id,carrier_id)
);
CREATE UNIQUE INDEX dispatch_line_once ON dispatch_invoice_lines(load_id) WHERE active;
CREATE INDEX dispatch_lines_by_invoice ON dispatch_invoice_lines(invoice_id);
CREATE TABLE dispatch_invoice_payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  received_on date NOT NULL,
  method text NOT NULL CHECK(method IN ('ach','check','wire','card','other')),
  reference text NOT NULL DEFAULT '' CHECK(length(reference)<=100),
  recorded_by uuid NOT NULL REFERENCES users,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY(invoice_id,carrier_id) REFERENCES dispatch_invoices(id,carrier_id),
  UNIQUE(recorded_by,idempotency_key)
);
CREATE TRIGGER immutable_carrier_receipts BEFORE UPDATE OR DELETE ON carrier_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
CREATE TRIGGER immutable_dispatch_payments BEFORE UPDATE OR DELETE ON dispatch_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION immutable_event();
