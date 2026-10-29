// Client-safe rules for what a load has earned and how long the cash is taking
// (ADR 0066). All money is integer minor units as strings; nothing here uses
// floating point. Shared by the server, the screens and the browser-only demo.
export type CashStage =
  | "not_delivered"
  | "waiting_on_pod"
  | "ready_for_packet"
  | "awaiting_payment"
  | "partly_paid"
  | "factored"
  | "paid";
export type WaitingOn = "driver" | "dispatcher" | "payer" | "factor" | null;
export const cashStageLabels: Record<CashStage, string> = {
  not_delivered: "Not delivered yet",
  waiting_on_pod: "Waiting for proof of delivery",
  ready_for_packet: "Ready to bill",
  awaiting_payment: "Waiting for payment",
  partly_paid: "Partly paid",
  factored: "With the factor",
  paid: "Paid",
};

export type CashInput = {
  delivered: boolean;
  pod_accepted: boolean;
  packet_amount_minor: string | null;
  packet_submitted: boolean;
  paid_minor: string;
  /** The load is on a schedule the carrier handed to its factor (ADR 0071). */
  factored?: boolean;
};
export function cashStage(i: CashInput): {
  stage: CashStage;
  waiting_on: WaitingOn;
} {
  if (!i.delivered) return { stage: "not_delivered", waiting_on: null };
  const paid = BigInt(i.paid_minor);
  if (i.packet_amount_minor && paid >= BigInt(i.packet_amount_minor))
    return { stage: "paid", waiting_on: null };
  // Sold to the factor: the factor, not the payer, is who the carrier waits on.
  if (i.factored) return { stage: "factored", waiting_on: "factor" };
  if (!i.pod_accepted) return { stage: "waiting_on_pod", waiting_on: "driver" };
  if (!i.packet_submitted)
    return { stage: "ready_for_packet", waiting_on: "dispatcher" };
  return paid > 0n
    ? { stage: "partly_paid", waiting_on: "payer" }
    : { stage: "awaiting_payment", waiting_on: "payer" };
}

/** Whole UTC calendar days from `from` to `to` (both ISO dates or timestamps), never negative. */
export function daysBetween(from: string, to: string): number {
  const day = (s: string) =>
    Math.floor(Date.parse(s.slice(0, 10) + "T00:00:00Z") / 864e5);
  return Math.max(0, day(to) - day(from));
}

/** Fee in minor units, rounded half up, integer arithmetic only. */
export function feeOf(grossMinor: string, bps: number): string {
  return ((BigInt(grossMinor) * BigInt(bps) + 5000n) / 10000n).toString();
}
export const netOf = (grossMinor: string, feeMinor: string): string =>
  (BigInt(grossMinor) - BigInt(feeMinor)).toString();

/** The date the running total of receipts first reached the amount, or null. */
export function paidOn(
  amountMinor: string | null,
  receipts: { amount_minor: string; received_on: string }[],
): string | null {
  if (!amountMinor) return null;
  let total = 0n;
  for (const r of [...receipts].sort((a, b) =>
    a.received_on.localeCompare(b.received_on),
  )) {
    total += BigInt(r.amount_minor);
    if (total >= BigInt(amountMinor)) return r.received_on;
  }
  return null;
}
/** Average of whole numbers, rounded half up; null when there are none. */
export function averageDays(days: number[]): number | null {
  if (!days.length) return null;
  const sum = days.reduce((a, b) => a + b, 0);
  return Math.floor((sum * 2 + days.length) / (days.length * 2));
}
