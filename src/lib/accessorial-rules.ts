// Client-safe detention and TONU rules (ADR 0067). Integer minutes and minor
// units only; shared by the server, the screens and the browser-only demo.
export type DetentionTerms = {
  free_minutes: number;
  rate_minor_per_hour: string;
  cap_minutes: number | null;
};
export type StopReport = { occurred_at: string; recorded_at: string } | null;
export type DetentionIssue =
  | "no_terms"
  | "not_arrived"
  | "not_departed"
  | "arrived_after_window"
  | "times_were_corrected"
  | "recorded_late";
export type DetentionCalc = {
  complete: boolean;
  clock_start: string | null;
  departed: string | null;
  dwell_minutes: number | null;
  free_minutes: number | null;
  billable_minutes: number;
  capped: boolean;
  amount_minor: string;
  late_minutes: number;
  issues: DetentionIssue[];
};
/** A time recorded more than this long after it happened is flagged. */
export const lateRecordingMinutes = 24 * 60;

const minutes = (a: string, b: string) =>
  Math.floor((Date.parse(b) - Date.parse(a)) / 60000);

/**
 * Free time starts at the later of the truck's arrival and the opening of the
 * appointment window; the clock stops at departure. Billable time is what
 * exceeds free time, up to any cap, paid per hour pro rata and rounded half up.
 */
export function detentionCalc(input: {
  terms: DetentionTerms | null;
  window_start: string;
  window_end: string;
  arrived: StopReport;
  departed: StopReport;
  corrected: boolean;
}): DetentionCalc {
  const { terms, arrived, departed } = input;
  const issues: DetentionIssue[] = [];
  if (!terms) issues.push("no_terms");
  if (!arrived) issues.push("not_arrived");
  if (arrived && !departed) issues.push("not_departed");
  const clock_start = arrived
    ? Date.parse(arrived.occurred_at) >= Date.parse(input.window_start)
      ? arrived.occurred_at
      : input.window_start
    : null;
  const late =
    arrived && Date.parse(arrived.occurred_at) > Date.parse(input.window_end)
      ? minutes(input.window_end, arrived.occurred_at)
      : 0;
  if (late > 0) issues.push("arrived_after_window");
  if (input.corrected) issues.push("times_were_corrected");
  for (const r of [arrived, departed])
    if (r && minutes(r.occurred_at, r.recorded_at) > lateRecordingMinutes) {
      issues.push("recorded_late");
      break;
    }
  const complete = !!(terms && arrived && departed);
  const dwell =
    clock_start && departed
      ? Math.max(0, minutes(clock_start, departed.occurred_at))
      : null;
  let billable = 0;
  let capped = false;
  if (terms && dwell !== null) {
    billable = Math.max(0, dwell - terms.free_minutes);
    if (terms.cap_minutes !== null && billable > terms.cap_minutes) {
      billable = terms.cap_minutes;
      capped = true;
    }
  }
  const amount = terms
    ? (BigInt(terms.rate_minor_per_hour) * BigInt(billable) + 30n) / 60n
    : 0n;
  return {
    complete,
    clock_start,
    departed: departed?.occurred_at ?? null,
    dwell_minutes: dwell,
    free_minutes: terms?.free_minutes ?? null,
    billable_minutes: billable,
    capped,
    amount_minor: amount.toString(),
    late_minutes: late,
    issues,
  };
}

/**
 * TONU applies to a load cancelled by the payer (the shipper or broker) after
 * it was dispatched and before pickup. A cancellation by the carrier, the
 * dispatcher or someone else never qualifies, and one with no recorded party
 * cannot be shown to.
 */
export function tonuEligibility(load: {
  cancelled: boolean;
  stage: string;
  party?: string | null;
}): { eligible: boolean; reason: string | null } {
  if (!load.cancelled)
    return { eligible: false, reason: "The load was not cancelled." };
  if (load.stage !== "dispatched")
    return {
      eligible: false,
      reason:
        "Only a load cancelled after dispatch and before pickup qualifies.",
    };
  if (!load.party)
    return {
      eligible: false,
      reason:
        "Who cancelled the order was not recorded, so a TONU claim cannot be shown.",
    };
  if (load.party !== "payer")
    return {
      eligible: false,
      reason:
        "Only a cancellation by the shipper or broker qualifies; this one was recorded as made by " +
        (load.party === "carrier"
          ? "the carrier"
          : load.party === "dispatch"
            ? "the dispatcher"
            : "someone else") +
        ".",
    };
  return { eligible: true, reason: null };
}
