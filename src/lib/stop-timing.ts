// Client-safe stop timing rules shared by the server, UI and demo adapter.
export type StopEventKind = "arrived" | "departed";
export type StopEvent = {
  id: string;
  kind: StopEventKind;
  occurred_at: string;
  recorded_at: string;
  actor_name: string;
  note: string;
  supersedes: string | null;
  reason: string | null;
};
export type TimedStop = {
  id?: string;
  kind: string;
  address: string;
  window_start: string;
  window_end: string;
  timezone: string;
  arrived?: StopEvent | null;
  departed?: StopEvent | null;
  stop_events?: StopEvent[];
};
/** Stops longer than this are flagged for possible detention. */
export const detentionMinutes = 120;

/** The current report of a kind is the one no later report supersedes. */
export function effective(events: StopEvent[], kind: StopEventKind) {
  const ofKind = events.filter((e) => e.kind === kind);
  const superseded = new Set(ofKind.map((e) => e.supersedes).filter(Boolean));
  return ofKind.find((e) => !superseded.has(e.id)) ?? null;
}

const minutesBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);

export function stopTiming(stop: TimedStop) {
  const arrived = stop.arrived?.occurred_at ?? null;
  const departed = stop.departed?.occurred_at ?? null;
  return {
    // Positive when the arrival came after the appointment window closed.
    lateMinutes:
      arrived && new Date(arrived) > new Date(stop.window_end)
        ? minutesBetween(stop.window_end, arrived)
        : 0,
    dwellMinutes:
      arrived && departed ? minutesBetween(arrived, departed) : null,
  };
}

/**
 * Checks that a proposed time keeps the route consistent with the other
 * effective reports. Out-of-sequence entry is allowed (a later stop may be
 * recorded first) but times must never run backwards along the route.
 */
export function stopTimeError(
  stops: TimedStop[],
  index: number,
  kind: StopEventKind,
  occurredAt: string,
): string | null {
  const at = new Date(occurredAt).getTime();
  const time = (e?: StopEvent | null) =>
    e ? new Date(e.occurred_at).getTime() : null;
  const stop = stops[index];
  const arrival = time(stop.arrived);
  const departure = time(stop.departed);
  if (kind === "departed") {
    if (arrival === null) return "STOP_ARRIVAL_REQUIRED";
    if (at < arrival) return "STOP_TIME_ORDER";
    const next = stops[index + 1];
    const nextArrival = next ? time(next.arrived) : null;
    if (nextArrival !== null && at > nextArrival) return "STOP_TIME_ORDER";
  } else {
    if (departure !== null && at > departure) return "STOP_TIME_ORDER";
    const previous = stops[index - 1];
    const before = previous
      ? (time(previous.departed) ?? time(previous.arrived))
      : null;
    if (before !== null && at < before) return "STOP_TIME_ORDER";
    const next = stops[index + 1];
    const nextArrival = next ? time(next.arrived) : null;
    if (nextArrival !== null && at > nextArrival) return "STOP_TIME_ORDER";
  }
  return null;
}
