import type { DocumentSlot } from "./compliance";
import type { ExceptionSuggestion, LoadException } from "./exception-rules";
export const stages = [
  "booked",
  "dispatched",
  "picked-up",
  "delivered",
] as const;
export type Stage = (typeof stages)[number];
export const stageLabels: Record<Stage, string> = {
  booked: "Booked",
  dispatched: "Dispatched",
  "picked-up": "In transit",
  delivered: "Delivered",
};
export type CheckIn = {
  id: string;
  location: string;
  note: string;
  source: "manual";
  observed_at: string;
  recorded_at: string;
  actor_name: string;
};
export type CheckInInput = {
  version: number;
  location: string;
  note: string;
  observed_at: string;
  idempotency_key: string;
};
export type Load = {
  id: string;
  reference: string;
  carrier_id: string;
  carrier_name?: string;
  stage: Stage;
  amount_minor: string;
  pickup: string;
  delivery: string;
  version: number;
  created_at: string;
  source: string;
  stops?: {
    kind: string;
    address: string;
    window_start: string;
    window_end: string;
    timezone: string;
  }[];
  events?: { id: string; type: string; created_at: string }[];
  events_truncated?: boolean;
  assignment?: { name: string; driver_id: string } | null;
  check_ins?: CheckIn[];
  documents?: DocumentSlot[];
  exceptions?: LoadException[];
  exception_suggestions?: ExceptionSuggestion[];
  exception_owners?: { id: string; name: string; role: string }[];
};
export type Context = {
  user: { name: string };
  carriers: { id: string; name: string; role: string }[];
  drivers: { id: string; name: string; carrier_id: string }[];
  organizations?: { id: string; name: string }[];
};
export type CarrierSetup = {
  carrier: { id: string; name: string; organization_id: string; role: string };
  profile: {
    contact_name: string;
    contact_email: string;
    phone: string;
    usdot: string;
    step: "agreement" | "team" | "complete";
    version: number;
  } | null;
  agreement: {
    agreement_ref: string;
    effective_at: string;
    expires_at: string;
    verified_at: string;
    current: boolean;
    document?: { version_id: string; filename: string } | null;
  } | null;
  drivers: {
    id: string;
    name: string;
    email: string | null;
    onboarding_status: "pending" | "ready";
    phone: string;
    timezone: string;
  }[];
  can_verify: boolean;
};
export type Queue = { loads: Load[]; nextCursor: string | null };
export type CarrierDocuments = {
  carrier_id: string;
  can_review: boolean;
  agreement: {
    agreement_ref: string;
    effective_at: string;
    expires_at: string;
    document_version_id: string | null;
    current: boolean;
  } | null;
  slots: DocumentSlot[];
};
export type PaymentState = "unpaid" | "partial" | "paid";
export type BillingPacket = {
  bill_to: string;
  carrier_invoice_number: string;
  amount_minor: string;
  status: "draft" | "submitted";
  submitted_at: string | null;
  version: number;
  paid_minor: string;
  payment_state: PaymentState;
  receipts: {
    id: string;
    amount_minor: string;
    received_on: string;
    reference: string;
  }[];
};
export type DispatchInvoice = {
  id: string;
  number: string | null;
  status: "draft" | "issued" | "void";
  fee_bps: number;
  total_minor: string;
  due_on: string;
  issued_at: string | null;
  void_reason: string | null;
  version: number;
  paid_minor: string;
  payment_state: PaymentState | null;
  lines: {
    load_id: string;
    reference: string;
    load_amount_minor: string;
    fee_minor: string;
  }[];
  payments: {
    id: string;
    amount_minor: string;
    received_on: string;
    method: string;
    reference: string;
  }[];
};
export type BillingOverview = {
  carrier_id: string;
  can_invoice: boolean;
  loads: {
    id: string;
    reference: string;
    stage: Stage;
    amount_minor: string;
    documents_ready: boolean;
    packet: BillingPacket | null;
    invoice: {
      invoice_id: string;
      number: string | null;
      status: string;
    } | null;
  }[];
  invoices: DispatchInvoice[];
};
