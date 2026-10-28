// Client-safe paperwork readiness rules (ADR 0068): for each required load
// document, whether it is done, and if not who has to act and what blocks.
import {
  documentLabels,
  type DocumentStatus,
  type LoadDocumentType,
} from "./compliance";

export type Owner = "driver" | "dispatcher" | "none";
export type ReadinessItem = {
  type: LoadDocumentType;
  label: string;
  status: DocumentStatus;
  owed_by: Owner;
  /** What the owner should do, in the owner's terms. */
  action: string | null;
  /** True when this item stops the carrier's billing packet from being sent. */
  blocks_billing: boolean;
};

/** Who supplies each document when it is missing or was rejected. */
const supplier: Record<LoadDocumentType, Owner> = {
  rate_confirmation: "dispatcher",
  bol: "driver",
  pod: "driver",
};

export function readinessItem(
  type: LoadDocumentType,
  status: DocumentStatus,
  delivered: boolean,
): ReadinessItem {
  const label = documentLabels[type];
  const done = status === "accepted" || status === "expiring";
  let owed_by: Owner = "none";
  let action: string | null = null;
  if (!done) {
    if (status === "pending_review") {
      owed_by = "dispatcher";
      action = `Review the ${label.toLowerCase()}`;
    } else {
      owed_by = supplier[type];
      action =
        status === "rejected"
          ? `Upload a corrected ${label.toLowerCase()}`
          : status === "expired"
            ? `Upload a current ${label.toLowerCase()}`
            : `Upload the ${label.toLowerCase()}`;
    }
  }
  // Only delivered freight can be billed; the later documents are simply not due yet.
  return {
    type,
    label,
    status,
    owed_by,
    action,
    blocks_billing: !done && delivered,
  };
}

export const ownerLabels: Record<Owner, string> = {
  driver: "Driver",
  dispatcher: "Dispatcher",
  none: "Nobody",
};
