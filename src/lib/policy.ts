import { HttpError } from "./auth";
import { access } from "./contacts";
import { pool } from "./db";

/**
 * Who may reach an API family at all, decided before the request body is read
 * or validated, so a person without the role learns nothing from field errors.
 * Handlers still check records and carriers; this is the first, coarse gate.
 * Every family in the router must be declared here (policy.test.ts fails
 * otherwise), so a new family forces an explicit decision.
 *
 *   public      no session needed; handled before sign-in is checked
 *   any         any signed-in person (records are checked by the handler)
 *   non-driver  organization staff, dispatchers and carrier managers; drivers get 404
 *   staff       organization staff and dispatchers only; carrier managers and drivers get 404
 *   org-admin   organization owners and admins only
 *   self        the person's own session or account
 */
export type Audience =
  | "public"
  | "any"
  | "non-driver"
  | "staff"
  | "org-admin"
  | "self";
export const familyAudience: Record<string, Audience> = {
  health: "public",
  webhooks: "public",
  auth: "public",
  login: "public",
  jobs: "public", // bearer secret; /jobs/status is checked by the handler
  onboarding: "any", // invitations are public and handled before sign-in
  logout: "self",
  me: "self",
  account: "self",
  fleet: "non-driver",
  "change-control": "non-driver",
  audit: "org-admin",
  documents: "any",
  extractions: "non-driver",
  carriers: "non-driver",
  billing: "non-driver",
  "dispatch-invoices": "non-driver",
  organizations: "any", // organization admins, checked by the handler
  views: "any",
  threads: "any",
  "message-deliveries": "any",
  messages: "any",
  "message-attachments": "any",
  inbox: "any",
  "saved-replies": "any",
  contacts: "any",
  "rate-confirmations": "any",
  notifications: "any",
  exceptions: "any",
  loads: "any",
  reports: "non-driver",
  "document-templates": "staff",
  drafts: "staff",
  assistant: "staff",
  prospects: "staff",
};

/** Throws NOT_FOUND (never 403, which would confirm the family exists) when the
 *  signed-in person is outside the family's audience. */
export async function enforceAudience(user: string, family: string) {
  const audience = familyAudience[family];
  if (audience === undefined) throw new HttpError(404, "NOT_FOUND");
  if (audience === "org-admin") {
    const admin = await pool.query(
      "SELECT 1 FROM organization_members WHERE user_id=$1 LIMIT 1",
      [user],
    );
    if (!admin.rowCount) throw new HttpError(404, "NOT_FOUND");
    return;
  }
  if (audience !== "staff" && audience !== "non-driver") return;
  const a = await access(pool, user);
  const staff = a.organizations.length > 0;
  const nonDriver =
    staff || a.dispatchCarriers.length > 0 || a.managerCarriers.length > 0;
  if (audience === "staff" ? !staff : !nonDriver)
    throw new HttpError(404, "NOT_FOUND");
}
