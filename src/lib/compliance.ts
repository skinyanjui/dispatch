// Shared by server handlers, the browser UI and the browser-only demo adapter.
export const carrierDocumentTypes = [
  "dispatch_agreement",
  "insurance_auto_liability",
  "insurance_cargo",
  "w9",
] as const;
export const loadDocumentTypes = ["rate_confirmation", "bol", "pod"] as const;
export type CarrierDocumentType = (typeof carrierDocumentTypes)[number];
export type LoadDocumentType = (typeof loadDocumentTypes)[number];
export type DocumentType = CarrierDocumentType | LoadDocumentType;
export const documentLabels: Record<DocumentType, string> = {
  dispatch_agreement: "Dispatch agreement",
  insurance_auto_liability: "Auto liability insurance",
  insurance_cargo: "Cargo insurance",
  w9: "W-9",
  rate_confirmation: "Rate confirmation",
  bol: "Bill of lading",
  pod: "Proof of delivery",
};
export const expiringTypes: readonly DocumentType[] = [
  "insurance_auto_liability",
  "insurance_cargo",
];
// Drivers may submit pickup and delivery paperwork for assigned loads only.
export const driverUploadTypes: readonly DocumentType[] = ["bol", "pod"];
export const maxDocumentBytes = 4 * 1024 * 1024;
export const expiringWithinDays = 30;

export type DocumentStatus =
  | "missing"
  | "pending_review"
  | "accepted"
  | "rejected"
  | "expiring"
  | "expired";
export const documentStatusLabels: Record<DocumentStatus, string> = {
  missing: "Missing",
  pending_review: "Awaiting review",
  accepted: "Accepted",
  rejected: "Rejected",
  expiring: "Expiring soon",
  expired: "Expired",
};
export type DocumentReview = {
  decision: "accepted" | "rejected";
  note: string;
  reviewer_name: string;
  created_at: string;
};
export type DocumentVersion = {
  id: string;
  version: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  expires_on: string | null;
  uploaded_at: string;
  uploader_name: string;
  review: DocumentReview | null;
};
export type DocumentSlot = {
  type: DocumentType;
  document_id: string | null;
  status: DocumentStatus;
  current: DocumentVersion | null;
  history: DocumentVersion[];
};

/** `today` is an ISO calendar date (UTC) so status is deterministic in tests. */
export function documentStatus(
  current: Pick<DocumentVersion, "expires_on" | "review"> | null,
  today: string,
): DocumentStatus {
  if (!current) return "missing";
  if (current.expires_on && current.expires_on < today) return "expired";
  if (!current.review) return "pending_review";
  if (current.review.decision === "rejected") return "rejected";
  if (current.expires_on) {
    const limit = new Date(Date.parse(today + "T00:00:00Z"));
    limit.setUTCDate(limit.getUTCDate() + expiringWithinDays);
    if (current.expires_on <= limit.toISOString().slice(0, 10))
      return "expiring";
  }
  return "accepted";
}
export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Identify file type from content, never from the client-supplied name/type. */
export function sniffContentType(bytes: Uint8Array): string | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return (cleaned || "document").slice(0, 200);
}
