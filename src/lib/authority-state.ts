// Client-safe rules for what a carrier authority lookup means (ADR 0065).
// Shared by the server, the screens and the browser-only demo.
export type AuthorityCheck = {
  outcome: "ok" | "not_found" | "error";
  source: "fixture" | "fmcsa";
  legal_name: string;
  authority_status: "active" | "inactive" | "revoked" | "unknown";
  allowed_to_operate: boolean | null;
  out_of_service: boolean | null;
  insurance_on_file: boolean | null;
  /** Some insurance is on file but less than the registry says is required. */
  insurance_shortfall: boolean | null;
  /** What the lookup found for the carrier's MC number, when it has one. */
  mc_outcome: McOutcome;
  observed_at: string;
};
export type McOutcome =
  | "not_checked"
  | "matches"
  | "different_carrier"
  | "not_found";
export type AuthorityFlag =
  | "dot_not_found"
  | "not_allowed_to_operate"
  | "authority_inactive"
  | "authority_revoked"
  | "out_of_service"
  | "no_insurance_on_file"
  | "insurance_below_required"
  | "mc_other_carrier"
  | "mc_not_found"
  | "name_differs"
  | "lookup_failed"
  | "usdot_changed"
  | "stale";
export type AuthorityState = "unchecked" | "clear" | "attention" | "unverified";
export const flagLabels: Record<AuthorityFlag, string> = {
  dot_not_found: "No carrier with this USDOT number",
  not_allowed_to_operate: "Not allowed to operate",
  authority_inactive: "Operating authority is inactive",
  authority_revoked: "Operating authority was revoked",
  out_of_service: "Ordered out of service",
  no_insurance_on_file: "No insurance on file",
  insurance_below_required:
    "Insurance on file is less than the registry says is required",
  mc_other_carrier:
    "The MC number belongs to a different carrier than this USDOT number",
  mc_not_found: "No carrier with this MC number",
  name_differs: "Registered name differs from the carrier's name",
  lookup_failed: "The last lookup failed",
  usdot_changed:
    "The USDOT or MC number changed since the last lookup, so nothing is confirmed for the new number",
  stale: "The last successful lookup is old",
};
/** A successful lookup older than this is shown as stale. */
export const staleAfterHours = 72;

/** Words that say what kind of company it is, not which one (ADR 0071). */
const legalWords = new Set([
  "llc",
  "inc",
  "incorporated",
  "co",
  "corp",
  "corporation",
  "company",
  "ltd",
  "lp",
  "llp",
  "pllc",
  "the",
  "of",
  "and",
  "a",
  "an",
]);
const genericWords = new Set([
  "transport",
  "transportation",
  "trucking",
  "truck",
  "trucks",
  "logistics",
  "freight",
  "express",
  "lines",
  "line",
  "carriers",
  "carrier",
  "hauling",
  "haul",
  "services",
  "service",
  "group",
  "holdings",
  "enterprises",
  "enterprise",
  "solutions",
  "delivery",
  "motor",
  "motors",
  "distribution",
  "international",
  "intl",
  "systems",
  "brothers",
  "bros",
  "sons",
  "partners",
]);
const distinctive = (name: string) =>
  new Set(
    name
      .toLowerCase()
      .replace(/\./g, "")
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !legalWords.has(w) && !genericWords.has(w)),
  );
/**
 * Whether two company names are plausibly the same business. Only the words
 * that tell companies apart count: "Transport LLC" names nobody, and a lone
 * short word matches only a name that is little more than it.
 */
export function sameName(registered: string, ours: string) {
  const a = distinctive(registered);
  const b = distinctive(ours);
  if (!a.size || !b.size) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (![...small].every((w) => large.has(w))) return false;
  if (small.size === large.size) return true;
  if (small.size >= 2) return true;
  const only = [...small][0];
  return only.length >= 5 && large.size <= 2;
}

export function deriveAuthority(
  latest: AuthorityCheck | null,
  lastOk: AuthorityCheck | null,
  carrierName: string,
  now = new Date(),
  /** Lookups exist, but only for another USDOT number than the one on file. */
  numberChanged = false,
): {
  state: AuthorityState;
  flags: AuthorityFlag[];
  source: string | null;
  observed_at: string | null;
  age_hours: number | null;
} {
  if (!latest && numberChanged)
    return {
      state: "attention",
      flags: ["usdot_changed"],
      source: null,
      observed_at: null,
      age_hours: null,
    };
  if (!latest)
    return {
      state: "unchecked",
      flags: [],
      source: null,
      observed_at: null,
      age_hours: null,
    };
  const age = (c: AuthorityCheck) =>
    Math.max(0, Math.round((now.getTime() - Date.parse(c.observed_at)) / 36e5));
  const flags: AuthorityFlag[] = [];
  if (latest.outcome === "not_found") flags.push("dot_not_found");
  if (latest.outcome === "error") flags.push("lookup_failed");
  const view = latest.outcome === "ok" ? latest : lastOk;
  if (view) {
    if (view.allowed_to_operate === false) flags.push("not_allowed_to_operate");
    if (view.authority_status === "inactive") flags.push("authority_inactive");
    if (view.authority_status === "revoked") flags.push("authority_revoked");
    if (view.out_of_service === true) flags.push("out_of_service");
    if (view.insurance_on_file === false)
      flags.push(
        view.insurance_shortfall
          ? "insurance_below_required"
          : "no_insurance_on_file",
      );
    if (view.mc_outcome === "different_carrier") flags.push("mc_other_carrier");
    if (view.mc_outcome === "not_found") flags.push("mc_not_found");
    if (view.legal_name && !sameName(view.legal_name, carrierName))
      flags.push("name_differs");
    if (age(view) > staleAfterHours) flags.push("stale");
  }
  // Findings about the carrier outrank trouble reaching the registry.
  const serious = flags.filter((f) => f !== "lookup_failed" && f !== "stale");
  const state: AuthorityState = serious.length
    ? "attention"
    : latest.outcome === "ok" && !flags.includes("stale")
      ? "clear"
      : "unverified";
  const shown = view ?? latest;
  return {
    state,
    flags,
    source: shown.source,
    observed_at: shown.observed_at,
    age_hours: age(shown),
  };
}
