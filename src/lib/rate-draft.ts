// Turns an AI reading of a rate confirmation into the values for the Create
// load form (ADR 0032). Pure and client-safe. The reading is advice: this
// only proposes form values and says what to check; a person reviews and
// submits the form through the normal create-load path.
import { draftStopCount, type Suggestions } from "./extraction";

export type DraftStop = {
  kind: "pickup" | "delivery";
  address: string;
  /** Local to the stop, YYYY-MM-DDTHH:mm, or empty when not found. */
  appointment: string;
  zone: string;
};
export type DraftFlag = { level: "check" | "missing"; message: string };
export type RateDraft = {
  reference: string;
  source: string;
  /** Whole dollars and cents as text, or empty. */
  amount: string;
  stops: DraftStop[];
  /** Keyed by form field: reference, source, amount, stop1_address, ... */
  flags: Record<string, DraftFlag>;
  /** What the file said for each field, to compare against. */
  quotes: Record<string, string>;
  /** Problems with the draft as a whole. */
  notes: string[];
};

const zones: Record<string, string> = {};
const put = (zone: string, states: string) =>
  states.split(" ").forEach((s) => (zones[s] = zone));
put(
  "America/New_York",
  "CT DE DC FL GA ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV IN KY",
);
put("America/Chicago", "AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI");
put("America/Denver", "CO ID MT NM UT WY");
put("America/Phoenix", "AZ");
put("America/Los_Angeles", "CA NV OR WA");
put("America/Anchorage", "AK");
put("Pacific/Honolulu", "HI");
export const defaultZone = "America/Chicago";

/** The state at the end of an address ("Nashville, TN 37201"), if any. */
export function stateOf(address: string) {
  const m = /\b([A-Z]{2})\b[\s,.]*(?:\d{5}(?:-\d{4})?)?[\s.]*$/.exec(
    address.trim(),
  );
  return m && zones[m[1]] ? m[1] : null;
}
export const zoneFor = (address: string) =>
  zones[stateOf(address) ?? ""] ?? defaultZone;

/** Integer cents to "2500.00" without floating point. */
export function centsToDollars(cents: number) {
  const whole = Math.trunc(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, "0")}`;
}

const kindOf = (raw: string): DraftStop["kind"] | null => {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, "");
  if (["pickup", "pu", "origin", "load", "loading"].includes(v))
    return "pickup";
  if (
    [
      "delivery",
      "drop",
      "dropoff",
      "destination",
      "unload",
      "unloading",
    ].includes(v)
  )
    return "delivery";
  return null;
};
const validLocal = (v: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v + ":00Z")) &&
  new Date(v + ":00Z").toISOString().startsWith(v);

export function rateDraft(fields: Suggestions, now = new Date()): RateDraft {
  const flags: RateDraft["flags"] = {};
  const quotes: RateDraft["quotes"] = {};
  const notes: string[] = [];
  const get = (name: string, form: string, label: string) => {
    const s = fields[name];
    if (!s || s.value === null || s.value === "") {
      flags[form] = {
        level: "missing",
        message: `${label} was not found in the file.`,
      };
      return null;
    }
    if (s.quote) quotes[form] = s.quote;
    if (s.confidence !== "high")
      flags[form] = {
        level: "check",
        message:
          s.confidence === "low"
            ? "Unsure. Check this one."
            : "Partly unclear. Check this one.",
      };
    return s.value;
  };
  const reference = get("reference", "reference", "The reference");
  const broker = get("broker_name", "source", "The broker");
  const rate = get("rate_minor", "amount", "The rate");
  const source = [broker, reference].filter(Boolean).join(" · ").slice(0, 100);
  if (flags.source && reference && !broker) delete flags.source;

  const stops: DraftStop[] = [];
  for (let n = 1; n <= draftStopCount; n++) {
    const address = fields[`stop${n}_address`]?.value;
    if (typeof address !== "string" || !address.trim()) continue;
    const position = stops.length + 1;
    const key = `stop${position}`;
    const kindRaw = fields[`stop${n}_kind`]?.value;
    let kind = typeof kindRaw === "string" ? kindOf(kindRaw) : null;
    if (!kind) {
      flags[`${key}_kind`] = {
        level: "check",
        message: "The stop type was unclear.",
      };
    }
    const when = fields[`stop${n}_appointment`]?.value;
    const appointment =
      typeof when === "string" && validLocal(when) ? when : "";
    if (!appointment)
      flags[`${key}_appointment`] = {
        level: "missing",
        message: "No usable appointment time was found in the file.",
      };
    for (const part of ["address", "appointment"] as const) {
      const s = fields[`stop${n}_${part}`];
      if (s?.quote) quotes[`${key}_${part}`] = s.quote;
      if (
        s &&
        s.value !== null &&
        s.confidence !== "high" &&
        !flags[`${key}_${part}`]
      )
        flags[`${key}_${part}`] = {
          level: "check",
          message:
            s.confidence === "low"
              ? "Unsure. Check this one."
              : "Partly unclear. Check this one.",
        };
    }
    // The zone is a guess from the state, never from the model.
    flags[`${key}_zone`] = {
      level: "check",
      message: stateOf(address)
        ? "Time zone guessed from the state. Check it."
        : "No state found, so Central time was assumed. Check it.",
    };
    stops.push({
      kind: kind ?? "pickup",
      address: address.trim(),
      appointment,
      zone: zoneFor(address),
    });
  }
  // A load starts at a pickup and ends at a delivery.
  if (stops.length) {
    if (stops[0].kind !== "pickup") {
      stops[0].kind = "pickup";
      notes.push("The first stop was set to a pickup. Check it.");
    }
    const last = stops.at(-1)!;
    if (stops.length > 1 && last.kind !== "delivery") {
      last.kind = "delivery";
      notes.push("The last stop was set to a delivery. Check it.");
    }
  }
  if (stops.length < 2)
    notes.push("Fewer than two stops were found, so add the rest by hand.");
  while (stops.length < 2)
    stops.push({
      kind: stops.length ? "delivery" : "pickup",
      address: "",
      appointment: "",
      zone: defaultZone,
    });
  let previous = "";
  for (const [i, s] of stops.entries()) {
    if (s.appointment && previous && s.appointment < previous)
      notes.push(`Stop ${i + 1} is earlier than the stop before it.`);
    if (s.appointment) previous = s.appointment;
    if (
      s.appointment &&
      Date.parse(s.appointment + ":00Z") < now.getTime() - 86_400_000
    )
      flags[`stop${i + 1}_appointment`] = {
        level: "check",
        message: "This appointment is in the past.",
      };
  }
  return {
    reference: typeof reference === "string" ? reference.slice(0, 100) : "",
    source,
    amount: typeof rate === "number" ? centsToDollars(rate) : "",
    stops,
    flags,
    quotes,
    notes,
  };
}
