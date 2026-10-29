// Shapes the screens read from the money-control endpoints (ADRs 0064-0069).
// Client-safe: types only, mirroring the server modules' responses.
import type { CashStage, WaitingOn } from "./cash";
import type { AuthorityFlag, AuthorityState } from "./authority-state";
import type { DetentionCalc } from "./accessorial-rules";
import type { ReadinessItem } from "./readiness-rules";

export type CashLoad = {
  id: string;
  reference: string;
  gross_minor: string;
  fee: {
    state: "invoiced" | "estimate" | "unknown";
    minor: string | null;
    bps: number | null;
    invoice_number: string | null;
  };
  net_minor: string | null;
  cash_stage: CashStage;
  waiting_on: WaitingOn;
  payer: string | null;
  delivered_on: string | null;
  packet_submitted_on: string | null;
  paid_on: string | null;
  paid_minor: string;
  owed_minor: string | null;
  days: {
    delivery_to_submit: number | null;
    submit_to_paid: number | null;
    to_cash: number | null;
    waiting: number | null;
  };
};
export type CashOverview = {
  carrier_id: string;
  as_of: string;
  fee_bps_preview: number | null;
  loads: CashLoad[];
  summary: {
    loads: number;
    gross_minor: string;
    net_loads: number;
    fee_minor: string;
    net_minor: string;
    outstanding_minor: string;
    unpaid: number;
    paid: number;
    avg_days_to_cash: number | null;
    oldest_waiting_days: number | null;
  };
};
export type ReadinessLoad = {
  id: string;
  reference: string;
  stage: string;
  delivered: boolean;
  delivered_on: string | null;
  days_outstanding: number | null;
  driver: string | null;
  items: ReadinessItem[];
  blocks_billing: boolean;
};
export type Readiness = {
  carrier_id: string;
  scope: "carrier" | "my_loads";
  loads: ReadinessLoad[];
  summary: {
    loads: number;
    blocking_billing: number;
    waiting_on_driver: number;
    waiting_on_dispatcher: number;
  };
};

export type FactoringOverview = {
  carrier_id: string;
  can_consent: boolean;
  settings: {
    enabled: boolean;
    factor_name: string;
    consented_by: string | null;
    consented_at: string | null;
  };
  payout_in_force: boolean;
  payout_cooling_off: boolean;
  loads: {
    id: string;
    reference: string;
    bill_to: string | null;
    invoice_number: string | null;
    amount_minor: string | null;
    eligible: boolean;
    reason: string | null;
    reason_label: string | null;
  }[];
  batches: {
    id: string;
    factor_name: string;
    status: "prepared" | "handed_off" | "void";
    load_count: number;
    total_minor: string;
    file_sha256: string;
    created_at: string;
    handed_off_at: string | null;
    void_reason: string | null;
    loads_held: boolean;
    version: number;
  }[];
};

export type AuthorityStatus = {
  carrier_id: string;
  usdot: string;
  provider: "fixture" | "fmcsa" | null;
  state: AuthorityState;
  flags: AuthorityFlag[];
  source: string | null;
  observed_at: string | null;
  age_hours: number | null;
  legal_name: string;
};

export type SensitiveChange = {
  id: string;
  kind: "payout_details" | "contact_details" | "reroute";
  summary: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "stale";
  current: unknown;
  proposed: unknown;
  requested_by_name: string;
  requested_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
  verification: "callback" | "document" | "in_person" | null;
  effective_at: string | null;
  can_decide: boolean;
  can_cancel: boolean;
};
export type ChangeControl = {
  cooling_hours: number;
  payout_details: {
    payee_name: string;
    method: string;
    account_last4: string;
    effective_at: string;
    cooling_off: boolean;
  } | null;
  can_decide: boolean;
  changes: SensitiveChange[];
};

export type ClaimTerms = {
  free_minutes: number;
  rate_minor_per_hour: string;
  cap_minutes: number | null;
  tonu_minor: string | null;
  source: "rate_confirmation" | "agreement" | "verbal";
  version: number;
  set_at: string;
};
export type ClaimStopEvidence = {
  stop: {
    id: string;
    sequence: number;
    kind: string;
    address: string;
    timezone: string;
    window_start: string;
    window_end: string;
  };
  events: unknown[];
  calc: DetentionCalc;
};
export type Claim = {
  id: string;
  load_id: string;
  load_reference: string;
  kind: "detention" | "tonu";
  stop_id: string | null;
  status: "draft" | "submitted" | "paid" | "denied";
  claimed_minor: string;
  settled_minor: string | null;
  note: string;
  outcome_note: string;
  created_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  version: number;
};
export type LoadClaims = {
  load_id: string;
  terms: ClaimTerms | null;
  detention: ClaimStopEvidence[];
  tonu: {
    eligible: boolean;
    reason: string | null;
    amount_minor: string | null;
  };
  claims: Claim[];
};
