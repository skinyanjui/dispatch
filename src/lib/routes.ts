/**
 * Addresses for the signed-in workspace (ADR 0045). Pure, so the server page
 * and the browser agree on what a path means. A path only names what to show;
 * whether the person may see it is always decided by the server's own checks.
 *
 *   /                         Loads
 *   /loads/:id                a load's record
 *   /carriers                 Carriers
 *   /carriers/:id             that carrier's setup
 *   /carriers/:id/documents   that carrier's documents
 *   /billing                  Billing
 *   /billing/invoices/:id     one dispatch invoice
 *   /audit                    the audit log (owners and admins)
 *   /<section>                any other page
 */
export const workspaceSections = [
  "loads",
  "carriers",
  "exceptions",
  "billing",
  "notifications",
  "account",
  "organization",
  "audit",
  "contacts",
  "prospects",
  "assistant",
  "inbox",
  "reports",
  "documents",
] as const;
export type WorkspaceSection = (typeof workspaceSections)[number];

export type Route = {
  section: WorkspaceSection;
  loadId?: string;
  invoiceId?: string;
  carrierId?: string;
  carrierPanel?: "setup" | "documents";
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sections = new Set<string>(workspaceSections);

/** Reads the path segments after the host; null means "no such page". */
export function parsePath(segments: string[]): Route | null {
  if (segments.length === 0) return { section: "loads" };
  const [first, second, third] = segments;
  if (first === "loads") {
    if (segments.length === 1) return { section: "loads" };
    if (segments.length === 2 && uuid.test(second))
      return { section: "loads", loadId: second.toLowerCase() };
    return null;
  }
  if (first === "carriers" && segments.length > 1) {
    if (!uuid.test(second)) return null;
    if (segments.length === 2)
      return {
        section: "carriers",
        carrierId: second.toLowerCase(),
        carrierPanel: "setup",
      };
    if (segments.length === 3 && third === "documents")
      return {
        section: "carriers",
        carrierId: second.toLowerCase(),
        carrierPanel: "documents",
      };
    return null;
  }
  if (first === "billing" && segments.length > 1) {
    if (segments.length === 3 && second === "invoices" && uuid.test(third))
      return { section: "billing", invoiceId: third.toLowerCase() };
    return null;
  }
  if (segments.length === 1 && sections.has(first))
    return { section: first as WorkspaceSection };
  return null;
}

/** The canonical path for a route; the inverse of `parsePath`. */
export function pathFor(route: Route): string {
  if (route.loadId) return `/loads/${route.loadId}`;
  if (route.invoiceId) return `/billing/invoices/${route.invoiceId}`;
  if (route.carrierId)
    return route.carrierPanel === "documents"
      ? `/carriers/${route.carrierId}/documents`
      : `/carriers/${route.carrierId}`;
  return route.section === "loads" ? "/" : `/${route.section}`;
}

type Who = {
  carriers: { role: string }[];
  organizations?: { role?: string | null }[];
};
/** Which pages a signed-in person is offered; the one rule the sidebar, the
 *  command menu and deep links share. The API still checks every request. */
export function sectionAllowed(section: WorkspaceSection, who: Who): boolean {
  const driverOnly =
    who.carriers.length > 0 && who.carriers.every((c) => c.role === "driver");
  const isAdmin = (who.organizations ?? []).some((o) => o.role);
  const orgStaff = isAdmin || who.carriers.some((c) => c.role === "dispatcher");
  switch (section) {
    case "carriers":
    case "billing":
    case "reports":
      return !driverOnly;
    case "prospects":
    case "assistant":
    case "documents":
      return !driverOnly && orgStaff;
    case "organization":
    case "audit":
      return isAdmin;
    default:
      return true;
  }
}
