import { Temporal } from "@js-temporal/polyfill";

export function dollarsToMinor(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match)
    throw new Error("Enter a USD amount with at most two decimal places.");
  const cents =
    BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The agreed rate is too large.");
  return Number(cents);
}

export function appointmentToInstant(value: string, timezone: string): string {
  try {
    return Temporal.PlainDateTime.from(value)
      .toZonedDateTime(timezone, { disambiguation: "reject" })
      .toInstant()
      .toString();
  } catch {
    throw new Error(
      "Check the appointment and time zone. Times skipped or repeated by daylight saving must be clarified before booking.",
    );
  }
}

export function formatMoney(minor: string | number): string {
  const value = BigInt(minor);
  return (
    "$" +
    (value / 100n).toLocaleString("en-US") +
    "." +
    (value % 100n).toString().padStart(2, "0")
  );
}

/** "8", "8.5" or "8.25" percent → integer basis points, without floats. */
export function percentToBps(value: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter a percentage with at most two decimals.");
  const bps = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (bps > 10000) throw new Error("The fee cannot exceed 100%.");
  return bps;
}
export function formatBps(bps: number): string {
  return (
    Math.floor(bps / 100) +
    (bps % 100
      ? "." +
        String(bps % 100)
          .padStart(2, "0")
          .replace(/0$/, "")
      : "") +
    "%"
  );
}
/** Fee in cents, rounded half up, using integer arithmetic only. */
export function feeMinor(amountMinor: string | number, bps: number): string {
  return ((BigInt(amountMinor) * BigInt(bps) + 5000n) / 10000n).toString();
}
