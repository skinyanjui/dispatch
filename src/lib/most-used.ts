import type { WorkspaceSection } from "./routes";

/**
 * Which page a person uses most, so the logo can take them there. Visits are
 * counted in this browser only (never sent anywhere) with the oldest fading,
 * so a change of habit wins within a couple of weeks. Utilities (Account,
 * Notifications, Organization, Audit log) never count.
 */
type Store = Pick<Storage, "getItem" | "setItem">;
type Tally = {
  scores: Partial<Record<WorkspaceSection, number>>;
  visits: number;
};

export const countedSections: readonly WorkspaceSection[] = [
  "loads",
  "exceptions",
  "inbox",
  "contacts",
  "carriers",
  "fleet",
  "prospects",
  "assistant",
  "documents",
  "billing",
  "reports",
];
/** Each new visit multiplies every earlier one by this, so recent use wins. */
export const fade = 0.95;
/** Fewer visits than this say nothing yet: the fallback is used. */
export const minimumVisits = 3;
const keyFor = (user: string) => `relay-page-visits:${user}`;

function read(store: Store, user: string): Tally {
  try {
    const parsed = JSON.parse(store.getItem(keyFor(user)) || "null");
    if (parsed && typeof parsed.visits === "number" && parsed.scores)
      return parsed as Tally;
  } catch {
    /* unreadable: start again */
  }
  return { scores: {}, visits: 0 };
}

export function recordVisit(
  store: Store | null,
  user: string,
  section: WorkspaceSection,
) {
  if (!store || !countedSections.includes(section)) return;
  const tally = read(store, user);
  for (const key of Object.keys(tally.scores) as WorkspaceSection[])
    tally.scores[key] = (tally.scores[key] ?? 0) * fade;
  tally.scores[section] = (tally.scores[section] ?? 0) + 1;
  tally.visits += 1;
  try {
    store.setItem(keyFor(user), JSON.stringify(tally));
  } catch {
    /* storage full or blocked: the logo just keeps its fallback */
  }
}

export function mostUsedSection(
  store: Store | null,
  user: string,
  allowed: (section: WorkspaceSection) => boolean,
  fallback: WorkspaceSection = "loads",
): WorkspaceSection {
  if (!store) return fallback;
  const tally = read(store, user);
  if (tally.visits < minimumVisits) return fallback;
  let best: WorkspaceSection = fallback,
    top = 0;
  for (const section of countedSections) {
    const score = tally.scores[section] ?? 0;
    if (allowed(section) && score > top) {
      best = section;
      top = score;
    }
  }
  return best;
}

/** localStorage when this browser lets us use it. */
export function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
