// Shared exception vocabulary and the rules that *suggest* exceptions. A
// suggestion is never stored; a person decides whether to open an exception.
import type { DocumentSlot, LoadDocumentType } from "./compliance";

export const exceptionTypes = [
  "delay",
  "missed_appointment",
  "missing_document",
  "other",
] as const;
export const exceptionSeverities = ["low", "medium", "high"] as const;
export const exceptionStatuses = ["open", "in_progress", "resolved"] as const;
export type ExceptionType = (typeof exceptionTypes)[number];
export type ExceptionSeverity = (typeof exceptionSeverities)[number];
export type ExceptionStatus = (typeof exceptionStatuses)[number];
export const exceptionTypeLabels: Record<ExceptionType, string> = {
  delay: "Delay",
  missed_appointment: "Missed appointment",
  missing_document: "Missing document",
  other: "Other",
};
export const exceptionStatusLabels: Record<ExceptionStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};
export type LoadException = {
  id: string;
  load_id: string;
  carrier_id: string;
  load_reference?: string;
  carrier_name?: string;
  type: ExceptionType;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  summary: string;
  details: string;
  document_type: LoadDocumentType | null;
  owner_id: string | null;
  owner_name: string | null;
  due_at: string | null;
  opened_by_name: string;
  opened_at: string;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution: string | null;
  version: number;
};
export type ExceptionSuggestion = {
  type: ExceptionType;
  severity: ExceptionSeverity;
  summary: string;
  document_type: LoadDocumentType | null;
};

type SuggestionInput = {
  stage: string;
  stops?: {
    kind: string;
    window_end: string;
    address?: string;
    arrived?: { occurred_at: string } | null;
    departed?: { occurred_at: string } | null;
  }[];
  documents?: DocumentSlot[];
  exceptions?: Pick<LoadException, "type" | "status" | "document_type">[];
};

/** Conservative checks against recorded data only; no tracking is implied. */
export function suggestExceptions(
  load: SuggestionInput,
  now: number,
): ExceptionSuggestion[] {
  const out: ExceptionSuggestion[] = [];
  const order = ["booked", "dispatched", "picked-up", "delivered"];
  const reached = (stage: string) =>
    order.indexOf(load.stage) >= order.indexOf(stage);
  const pickup = load.stops?.find((s) => s.kind === "pickup");
  // Milestones are load-level: the first pickup and the final delivery.
  const delivery = [...(load.stops || [])]
    .reverse()
    .find((s) => s.kind === "delivery");
  const time = (v: string) => new Date(v).getTime();
  // A recorded departure from the first pickup (or arrival at the final
  // delivery) shows the appointment was met even before the milestone.
  if (
    pickup &&
    !reached("picked-up") &&
    !pickup.departed &&
    time(pickup.window_end) < now
  )
    out.push({
      type: "missed_appointment",
      severity: "high",
      summary: "Pickup window ended without a picked-up milestone",
      document_type: null,
    });
  if (
    delivery &&
    !reached("delivered") &&
    !delivery.arrived &&
    time(delivery.window_end) < now
  )
    out.push({
      type: "missed_appointment",
      severity: "high",
      summary: "Delivery window ended without a delivered milestone",
      document_type: null,
    });
  (load.stops || []).forEach((stop, i) => {
    const label = `stop ${i + 1}${stop.address ? ` (${stop.address})` : ""}`;
    if (stop.arrived) {
      const late = Math.round(
        (time(stop.arrived.occurred_at) - time(stop.window_end)) / 60000,
      );
      if (late > 0)
        out.push({
          type: "delay",
          severity: late >= 120 ? "high" : "medium",
          summary: `Arrived ${late} min after the window at ${label}`,
          document_type: null,
        });
    } else if (
      stop !== pickup &&
      stop !== delivery &&
      !reached("delivered") &&
      time(stop.window_end) < now
    )
      out.push({
        type: "missed_appointment",
        severity: "high",
        summary: `Window ended without a recorded arrival at ${label}`,
        document_type: null,
      });
  });
  const status = (type: LoadDocumentType) =>
    load.documents?.find((d) => d.type === type)?.status ?? "missing";
  const needs: [LoadDocumentType, boolean][] = [
    ["rate_confirmation", reached("dispatched")],
    ["bol", reached("picked-up")],
    ["pod", reached("delivered")],
  ];
  for (const [type, required] of needs)
    if (required && ["missing", "rejected"].includes(status(type)))
      out.push({
        type: "missing_document",
        severity: type === "pod" ? "high" : "medium",
        summary:
          (type === "rate_confirmation"
            ? "Rate confirmation"
            : type === "bol"
              ? "Bill of lading"
              : "Proof of delivery") +
          (status(type) === "rejected" ? " was rejected" : " is missing"),
        document_type: type,
      });
  const active = (load.exceptions || []).filter((e) => e.status !== "resolved");
  return out.filter(
    (s) =>
      !active.some(
        (e) => e.type === s.type && e.document_type === s.document_type,
      ),
  );
}
