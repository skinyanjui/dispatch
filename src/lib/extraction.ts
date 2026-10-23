// AI document reading (ADR 0028). Shared by the server, the browser UI and the
// browser-only demo, so it must not import server code. The model only ever
// suggests values; `extractionChecks` compares them with what Relay has
// recorded using plain code, and nothing here writes to a load or document.
import { z } from "zod";
import { formatMoney } from "./entry";

/** Bump when the instructions or fields change, so old results stay explainable. */
export const promptVersion = "2026-10-22.1";

export type FieldKind = "text" | "date" | "datetime" | "cents" | "flag";
type FieldSpec = { label: string; kind: FieldKind };

function stopFields<N extends number>(n: N) {
  return {
    [`stop${n}_kind`]: {
      label: `Stop ${n} type (pickup or delivery)`,
      kind: "text",
    },
    [`stop${n}_address`]: {
      label: `Stop ${n} facility and city, state`,
      kind: "text",
    },
    [`stop${n}_appointment`]: {
      label: `Stop ${n} appointment, local time, start of the window (YYYY-MM-DDTHH:mm)`,
      kind: "datetime",
    },
  } as {
    [K in
      | `stop${N}_kind`
      | `stop${N}_address`
      | `stop${N}_appointment`]: FieldSpec;
  };
}

/**
 * Only paperwork a person reviews anyway is readable. W-9s (tax ID numbers)
 * and dispatch agreements (legal authority to book freight) are never sent.
 */
export const extractionFields = {
  insurance_auto_liability: {
    insurer: { label: "Insurer", kind: "text" },
    policy_number: { label: "Policy number", kind: "text" },
    named_insured: { label: "Named insured", kind: "text" },
    effective_date: { label: "Effective date", kind: "date" },
    expiry_date: { label: "Expiry date", kind: "date" },
    coverage_limit_minor: { label: "Coverage limit", kind: "cents" },
  },
  insurance_cargo: {
    insurer: { label: "Insurer", kind: "text" },
    policy_number: { label: "Policy number", kind: "text" },
    named_insured: { label: "Named insured", kind: "text" },
    effective_date: { label: "Effective date", kind: "date" },
    expiry_date: { label: "Expiry date", kind: "date" },
    coverage_limit_minor: { label: "Coverage limit", kind: "cents" },
  },
  rate_confirmation: {
    reference: { label: "Reference", kind: "text" },
    broker_name: { label: "Broker", kind: "text" },
    rate_minor: { label: "Rate", kind: "cents" },
    pickup_date: { label: "Pickup date", kind: "date" },
    delivery_date: { label: "Delivery date", kind: "date" },
  },
  bol: {
    bol_number: { label: "BOL number", kind: "text" },
    ship_date: { label: "Ship date", kind: "date" },
    shipper_name: { label: "Shipper", kind: "text" },
    consignee_name: { label: "Consignee", kind: "text" },
  },
  pod: {
    delivered_date: { label: "Delivered on", kind: "date" },
    receiver_name: { label: "Received by", kind: "text" },
    signed: { label: "Signed", kind: "flag" },
    exceptions_noted: { label: "Damage or shortage noted", kind: "text" },
  },
  // Everything needed to start a draft load from a rate confirmation (ADR 0032).
  // Stops are flattened and numbered in route order; the model never decides
  // time zones, which are inferred from the address by plain code.
  rate_confirmation_load: {
    reference: { label: "Load or confirmation reference", kind: "text" },
    broker_name: { label: "Broker", kind: "text" },
    rate_minor: { label: "Rate", kind: "cents" },
    ...stopFields(1),
    ...stopFields(2),
    ...stopFields(3),
    ...stopFields(4),
  },
} as const satisfies Record<string, Record<string, FieldSpec>>;

export type ExtractableType = keyof typeof extractionFields;
/** The draft-load reading, which is not a stored document type. */
export const draftType = "rate_confirmation_load" as const;
export const draftStopCount = 4;
/** Paperwork on a load or carrier that the document screens can read. */
export const isExtractable = (type: string): type is ExtractableType =>
  type in extractionFields && type !== draftType;

export const confidenceLevels = ["high", "medium", "low"] as const;
export type Suggestion = {
  value: string | number | boolean | null;
  confidence: (typeof confidenceLevels)[number];
  /** Text copied from the document so a person can find it. */
  quote: string;
};
export type Suggestions = Record<string, Suggestion>;

const strictValue: Record<FieldKind, z.ZodType> = {
  text: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  flag: z.boolean(),
};
// Structured outputs accept a subset of JSON Schema (no patterns or ranges),
// so the request schema is plain and the stricter one runs on the result.
const wireValue: Record<FieldKind, z.ZodType> = {
  text: z.string(),
  date: z.string(),
  datetime: z.string(),
  cents: z.number(),
  flag: z.boolean(),
};

function shape(type: ExtractableType, strict: boolean) {
  const specs = Object.entries(extractionFields[type]) as [string, FieldSpec][];
  const entries = specs.map(([key, spec]) => [
    key,
    z.object({
      value: (strict ? strictValue : wireValue)[spec.kind].nullable(),
      confidence: z.enum(confidenceLevels),
      quote: strict ? z.string().max(240) : z.string(),
    }),
  ]);
  return z.object(Object.fromEntries(entries));
}
/** Schema sent to the model. */
export const wireSchema = (type: ExtractableType) => shape(type, false);
/** Schema every result must satisfy before it is stored. */
export const resultSchema = (type: ExtractableType) => shape(type, true);

export type Recorded = {
  /** Expiry date entered when the file was uploaded (YYYY-MM-DD). */
  expires_on?: string | null;
  load?: {
    amount_minor: string;
    stops: { window_start: string; window_end: string; timezone: string }[];
  } | null;
};
export type Check = {
  field: string;
  level: "ok" | "differs" | "note";
  message: string;
};

const dayIn = (instant: string, timezone: string) =>
  new Date(instant).toLocaleDateString("en-CA", { timeZone: timezone });

/**
 * Compares suggestions with Relay's own records. Deterministic and free:
 * a mismatch is a reason for a person to look, never a change.
 */
export function extractionChecks(
  type: ExtractableType,
  fields: Suggestions,
  recorded: Recorded,
  today = new Date().toISOString().slice(0, 10),
): Check[] {
  const checks: Check[] = [];
  const value = (key: string) => fields[key]?.value ?? null;
  const labelOf = (key: string) =>
    (extractionFields[type] as Record<string, FieldSpec>)[key]?.label ?? key;
  for (const [key, s] of Object.entries(fields))
    if (s.value === null)
      checks.push({
        field: key,
        level: "note",
        message: `${labelOf(key)} was not found in the file.`,
      });
  const first = recorded.load?.stops[0];
  const last = recorded.load?.stops.at(-1);
  if (type === "insurance_auto_liability" || type === "insurance_cargo") {
    const expiry = value("expiry_date");
    if (typeof expiry === "string") {
      if (recorded.expires_on && recorded.expires_on !== expiry)
        checks.push({
          field: "expiry_date",
          level: "differs",
          message: `The file says it expires ${expiry}, but ${recorded.expires_on} was entered.`,
        });
      else if (recorded.expires_on)
        checks.push({
          field: "expiry_date",
          level: "ok",
          message: "Expiry date matches the one entered.",
        });
      if (expiry < today)
        checks.push({
          field: "expiry_date",
          level: "differs",
          message: `The policy on the file already expired on ${expiry}.`,
        });
    }
  }
  if (type === "rate_confirmation") {
    const rate = value("rate_minor");
    if (typeof rate === "number" && recorded.load) {
      const same = BigInt(rate) === BigInt(recorded.load.amount_minor);
      checks.push({
        field: "rate_minor",
        level: same ? "ok" : "differs",
        message: same
          ? "Rate matches the load's agreed rate."
          : `The file says ${formatMoney(rate)}; the load's agreed rate is ${formatMoney(recorded.load.amount_minor)}.`,
      });
    }
    const pairs: [string, typeof first, string][] = [
      ["pickup_date", first, "pickup"],
      ["delivery_date", last, "delivery"],
    ];
    for (const [key, stop, word] of pairs) {
      const date = value(key);
      if (typeof date !== "string" || !stop) continue;
      const planned = dayIn(stop.window_start, stop.timezone);
      checks.push({
        field: key,
        level: planned === date ? "ok" : "differs",
        message:
          planned === date
            ? `The ${word} date matches the load.`
            : `The file says ${word} on ${date}; the load has ${planned}.`,
      });
    }
  }
  if (type === "pod") {
    if (value("signed") === false)
      checks.push({
        field: "signed",
        level: "differs",
        message: "The proof of delivery does not look signed.",
      });
    const note = value("exceptions_noted");
    if (typeof note === "string")
      checks.push({
        field: "exceptions_noted",
        level: "differs",
        message: "Damage or a shortage is written on the proof of delivery.",
      });
    const date = value("delivered_date");
    if (typeof date === "string" && last) {
      const planned = dayIn(last.window_end, last.timezone);
      if (date !== planned)
        checks.push({
          field: "delivered_date",
          level: "note",
          message: `Delivered ${date}; the appointment was ${planned}.`,
        });
    }
  }
  return checks;
}

export type ExtractionView = {
  id: string;
  status: "running" | "succeeded" | "failed" | "dismissed";
  provider: string;
  model: string;
  prompt_version: string;
  fields: Suggestions | null;
  error_code: string | null;
  created_at: string;
  checked_at: string | null;
  checked_by_name: string | null;
  checked_fields: Record<string, string | number | boolean | null> | null;
};

/**
 * Labelled sample values for QA, the browser-only demo and tests. They are not
 * read from any file and the interface says so.
 */
export function sampleSuggestions(type: ExtractableType): Suggestions {
  const text = (value: string): Suggestion => ({
    value,
    confidence: "high",
    quote: value,
  });
  const date = text;
  const cents = (value: number): Suggestion => ({
    value,
    confidence: "medium",
    quote: `$${(value / 100).toFixed(2)}`,
  });
  const none: Suggestion = { value: null, confidence: "high", quote: "" };
  const policy = (limit: number, prefix: string): Suggestions => ({
    insurer: text("Sample Mutual Insurance"),
    policy_number: text(`SAMPLE-${prefix}-0001`),
    named_insured: text("Sample Carrier LLC"),
    effective_date: date("2026-01-01"),
    expiry_date: date("2027-01-01"),
    coverage_limit_minor: cents(limit),
  });
  switch (type) {
    case "insurance_auto_liability":
      return policy(100_000_000, "AL");
    case "insurance_cargo":
      return policy(10_000_000, "CG");
    case "rate_confirmation":
      return {
        reference: text("SAMPLE-RC-1"),
        broker_name: text("Sample Brokerage"),
        rate_minor: cents(260_000),
        pickup_date: date("2026-11-05"),
        delivery_date: date("2026-11-06"),
      };
    case "rate_confirmation_load": {
      // Relative to now, so the sample always fills a valid future load.
      const at = (days: number, time: string) =>
        new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) +
        "T" +
        time;
      const stop = (
        n: number,
        kind: string,
        address: string,
        when: string,
      ) => ({
        [`stop${n}_kind`]: text(kind),
        [`stop${n}_address`]: text(address),
        [`stop${n}_appointment`]: text(when),
      });
      const missing = (n: number) => ({
        [`stop${n}_kind`]: none,
        [`stop${n}_address`]: none,
        [`stop${n}_appointment`]: none,
      });
      return {
        reference: text("SAMPLE-RC-1001"),
        broker_name: text("Sample Freight Brokers"),
        rate_minor: cents(250_000),
        ...stop(1, "pickup", "Sample Warehouse, Chicago, IL", at(3, "09:00")),
        ...stop(
          2,
          "delivery",
          "Sample Distribution, Nashville, TN",
          at(4, "14:00"),
        ),
        ...missing(3),
        ...missing(4),
      } as Suggestions;
    }
    case "bol":
      return {
        bol_number: text("SAMPLE-BOL-1"),
        ship_date: date("2026-11-05"),
        shipper_name: text("Sample Shipper"),
        consignee_name: text("Sample Consignee"),
      };
    case "pod":
      return {
        delivered_date: date("2026-11-06"),
        receiver_name: text("Sample Receiver"),
        signed: { value: true, confidence: "high", quote: "signature" },
        exceptions_noted: none,
      };
  }
}
