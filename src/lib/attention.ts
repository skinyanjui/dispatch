// What needs a dispatcher's attention, decided in one place (ADR 0029). Pure
// code shared by the server, the browser UI and the demo. It reads recorded
// data only (appointments, arrivals, assignment, paperwork status, exceptions);
// it does not claim to know where a truck is.
import {
  documentLabels,
  loadDocumentTypes,
  type DocumentStatus,
  type LoadDocumentType,
} from "./compliance";

export const attentionKeys = [
  "late",
  "soon",
  "no_driver",
  "paperwork",
  "exception",
] as const;
export type AttentionKey = (typeof attentionKeys)[number];
export const attentionLabels: Record<AttentionKey, string> = {
  late: "Late",
  soon: "Next 4 hours",
  no_driver: "No driver",
  paperwork: "Paperwork",
  exception: "Exceptions",
};
export type AttentionReason = { key: AttentionKey; text: string };
export type AttentionLevel = "late" | "soon" | "attention" | "ok";

export type LoadSummary = {
  driver_name: string | null;
  /** The first stop that has not been left yet. */
  next: {
    label: string;
    address: string;
    window_start: string;
    window_end: string;
    timezone: string;
    arrived: boolean;
  } | null;
  docs: {
    accepted: number;
    pending: number;
    rejected: number;
    missing: number;
  };
  exceptions: { open: number; overdue: number };
  attention: {
    level: AttentionLevel;
    reasons: AttentionReason[];
    /** One line saying what to do or what is happening. */
    next_step: string;
  };
};

export type AttentionInput = {
  stage: string;
  cancelled: boolean;
  driver_name: string | null;
  stops: {
    kind: string;
    address: string;
    window_start: string;
    window_end: string;
    timezone: string;
    arrived?: unknown;
    departed?: unknown;
  }[];
  docs: Record<LoadDocumentType, DocumentStatus>;
  /** Open (unresolved) exceptions only. */
  exceptions: { due_at: string | null }[];
};

const soonMs = 4 * 3_600_000;
const order = ["booked", "dispatched", "picked-up", "delivered"];

/** "20 min", "3h 10m", "2 days": the size of a gap, never a clock time. */
export function span(ms: number) {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60)
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.round(minutes / 1440)} days`;
}

export function summarize(input: AttentionInput, now: number): LoadSummary {
  const reached = (stage: string) =>
    order.indexOf(input.stage) >= order.indexOf(stage);
  const { stops } = input;
  const firstPickup = stops.findIndex((s) => s.kind === "pickup");
  // Milestones are load-level: a picked-up load is past its first pickup and a
  // delivered load is past everything, even without per-stop reports.
  const done = (stop: AttentionInput["stops"][number], i: number) =>
    Boolean(stop.departed) ||
    reached("delivered") ||
    (i === firstPickup && reached("picked-up"));
  const nextIndex = stops.findIndex((s, i) => !done(s, i));
  const stop = nextIndex >= 0 ? stops[nextIndex] : null;
  const label = stop
    ? `${stop.kind === "pickup" ? "Pickup" : "Delivery"}${stops.length > 2 ? ` ${nextIndex + 1}` : ""}`
    : "";
  const next = stop
    ? {
        label,
        address: stop.address,
        window_start: stop.window_start,
        window_end: stop.window_end,
        timezone: stop.timezone,
        arrived: Boolean(stop.arrived),
      }
    : null;

  const docStates = loadDocumentTypes.map((t) => input.docs[t]);
  const docs = {
    accepted: docStates.filter((s) => s === "accepted" || s === "expiring")
      .length,
    pending: docStates.filter((s) => s === "pending_review").length,
    rejected: docStates.filter((s) => s === "rejected").length,
    missing: docStates.filter((s) => s === "missing" || s === "expired").length,
  };
  const overdue = input.exceptions.filter(
    (e) => e.due_at && Date.parse(e.due_at) < now,
  ).length;
  const exceptions = { open: input.exceptions.length, overdue };

  const reasons: AttentionReason[] = [];
  const live = !input.cancelled && input.stage !== "delivered";
  if (overdue)
    reasons.push({
      key: "late",
      text:
        overdue === 1
          ? "An exception is overdue"
          : `${overdue} exceptions are overdue`,
    });
  if (live && next && !next.arrived) {
    const start = Date.parse(next.window_start);
    const end = Date.parse(next.window_end);
    if (end < now)
      reasons.push({
        key: "late",
        text: `${next.label} was due ${span(now - end)} ago`,
      });
    else if (start - now <= soonMs)
      reasons.push({
        key: "soon",
        text:
          start <= now
            ? `${next.label} window is open`
            : `${next.label} in ${span(start - now)}`,
      });
  }
  if (!input.cancelled && !input.driver_name && input.stage !== "delivered")
    reasons.push({ key: "no_driver", text: "Needs a driver" });
  if (!input.cancelled) {
    // Paperwork is expected as the load moves: the rate confirmation once it
    // is dispatched, the BOL once picked up, the POD once delivered.
    const needed: [LoadDocumentType, boolean][] = [
      ["rate_confirmation", reached("dispatched")],
      ["bol", reached("picked-up")],
      ["pod", reached("delivered")],
    ];
    for (const [type, due] of needed) {
      const status = input.docs[type];
      const name = documentLabels[type];
      if (status === "rejected")
        reasons.push({ key: "paperwork", text: `${name} was rejected` });
      else if (status === "pending_review")
        reasons.push({
          key: "paperwork",
          text: `Review the ${name.toLowerCase()}`,
        });
      else if (due && (status === "missing" || status === "expired"))
        reasons.push({ key: "paperwork", text: `${name} is missing` });
    }
  }
  const quiet = exceptions.open - overdue;
  if (!input.cancelled && quiet > 0)
    reasons.push({
      key: "exception",
      text: quiet === 1 ? "1 open exception" : `${quiet} open exceptions`,
    });

  const has = (key: AttentionKey) => reasons.some((r) => r.key === key);
  const level: AttentionLevel = has("late")
    ? "late"
    : has("soon")
      ? "soon"
      : reasons.length
        ? "attention"
        : "ok";
  const stageStep =
    input.stage === "booked"
      ? "Ready to dispatch"
      : input.stage === "dispatched"
        ? "Waiting for pickup"
        : input.stage === "picked-up"
          ? "On its way to delivery"
          : docs.accepted === loadDocumentTypes.length
            ? "Delivered, paperwork complete"
            : "Delivered";
  return {
    driver_name: input.driver_name,
    next,
    docs,
    exceptions,
    attention: {
      level,
      reasons,
      next_step: reasons[0]?.text ?? stageStep,
    },
  };
}

/** Most urgent first, then the soonest appointment. */
export function byUrgency(
  a: { summary: LoadSummary },
  b: { summary: LoadSummary },
) {
  const rank = { late: 0, soon: 1, attention: 2, ok: 3 } as const;
  const by = rank[a.summary.attention.level] - rank[b.summary.attention.level];
  if (by) return by;
  const at = (x: { summary: LoadSummary }) =>
    x.summary.next ? Date.parse(x.summary.next.window_start) : Infinity;
  return at(a) - at(b);
}
