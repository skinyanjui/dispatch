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
  stops?: { kind: string; window_end: string }[];
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
  const delivery = load.stops?.find((s) => s.kind === "delivery");
  if (
    pickup &&
    !reached("picked-up") &&
    new Date(pickup.window_end).getTime() < now
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
    new Date(delivery.window_end).getTime() < now
  )
    out.push({
      type: "missed_appointment",
      severity: "high",
      summary: "Delivery window ended without a delivered milestone",
      document_type: null,
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
