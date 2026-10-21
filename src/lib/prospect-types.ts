// Client-safe prospect vocabulary and wire types (ADR 0030).
export const prospectStages = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "won",
  "lost",
] as const;
export type ProspectStage = (typeof prospectStages)[number];
export const stageLabels: Record<ProspectStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Agreement sent",
  won: "Won",
  lost: "Lost",
};
export const prospectSources = [
  "referral",
  "inbound",
  "load_board",
  "cold_outreach",
  "event",
  "other",
] as const;
export type ProspectSource = (typeof prospectSources)[number];
export const sourceLabels: Record<ProspectSource, string> = {
  referral: "Referral",
  inbound: "Inbound",
  load_board: "Load board",
  cold_outreach: "Cold outreach",
  event: "Event",
  other: "Other",
};
export const activityKinds = ["note", "call", "email", "meeting"] as const;
export type ActivityKind = (typeof activityKinds)[number];
export const activityLabels: Record<
  ActivityKind | "stage" | "converted",
  string
> = {
  note: "Note",
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  stage: "Stage change",
  converted: "Carrier setup started",
};

export type Prospect = {
  id: string;
  organization_id: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  usdot: string;
  truck_count: number | null;
  source: ProspectSource;
  stage: ProspectStage;
  lost_reason: string;
  owner: { id: string; name: string } | null;
  next_follow_up_on: string | null;
  notes: string;
  carrier_id: string | null;
  stage_changed_at: string;
  last_activity_at: string | null;
  version: number;
};
export type ProspectActivity = {
  id: string;
  kind: ActivityKind | "stage" | "converted";
  body: string;
  actor_name: string;
  created_at: string;
};
export type FollowUp = "overdue" | "today" | "week";
export type ProspectList = {
  prospects: Prospect[];
  /** Counts across everything the caller can see, ignoring filters. */
  counts: Record<ProspectStage, number>;
  follow_ups: Record<FollowUp, number>;
  team: { id: string; name: string; organization_id: string }[];
  organizations: { id: string; name: string }[];
  truncated: boolean;
  /** The server's date, so counts and card text agree. */
  today: string;
};
export type ProspectDetail = {
  prospect: Prospect;
  activities: ProspectActivity[];
};

/** Whole days from `today` to a YYYY-MM-DD date (negative when past). */
export function daysUntil(date: string, today: string) {
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}
export function followUpText(date: string | null, today: string) {
  if (!date) return "";
  const days = daysUntil(date, today);
  if (days < 0)
    return `Follow-up ${-days === 1 ? "1 day" : -days + " days"} overdue`;
  if (days === 0) return "Follow up today";
  if (days === 1) return "Follow up tomorrow";
  return `Follow up in ${days} days`;
}
