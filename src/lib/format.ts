// One formatting strategy for values shown in the interface
// (docs/design-system.md, section 7). Money is integer minor units (ADR 0009);
// times are shown in the viewer's time zone unless a stop's zone is given.
// Components call these helpers; they never call toLocaleString themselves.
import { formatMoney } from "./entry";

export { formatMoney };

/** Which parts of a moment to show. */
export type InstantParts = {
  /** "Mon" before the date. */
  weekday?: "short" | "long";
  /** "Oct 22" (short), "Oct 22, 2026" (year), "October 22" (long). */
  date?: "short" | "year" | "long";
  /** "11:45 PM". */
  time?: boolean;
  /** Show it in this IANA zone (a stop's local time). */
  zone?: string;
  /** Add the zone's short name, e.g. "CDT". */
  zoneName?: boolean;
};

/** The one place moments are turned into words. */
export function formatInstant(value: string | Date, parts: InstantParts) {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-US", {
    ...(parts.weekday ? { weekday: parts.weekday } : {}),
    ...(parts.date
      ? {
          month: parts.date === "long" ? "long" : "short",
          day: "numeric",
          ...(parts.date === "year" ? { year: "numeric" } : {}),
        }
      : {}),
    ...(parts.time ? { hour: "numeric", minute: "2-digit" } : {}),
    ...(parts.zone ? { timeZone: parts.zone } : {}),
    ...(parts.zoneName ? { timeZoneName: "short" } : {}),
  });
}

/** "Oct 22, 11:45 PM": when something happened, this year. */
export const formatDateTime = (iso: string, zone?: string) =>
  formatInstant(iso, { date: "short", time: true, zone });

/** "Oct 22, 2026, 11:45 PM": a record date that may be from another year. */
export const formatDateTimeLong = (iso: string, zone?: string) =>
  formatInstant(iso, { date: "year", time: true, zone });

/** "Oct 22". */
export const formatShortDate = (value: string | Date) =>
  formatInstant(value, { date: "short" });

/** "11:45 PM". */
export const formatTime = (value: string | Date, zone?: string) =>
  formatInstant(value, { time: true, zone });

/** "October 2026", a calendar's title. */
export const formatMonth = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

/** "Oct 22, 2026" for an ISO date or timestamp. A plain date is read as UTC. */
export function formatDate(value: string) {
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return formatInstant(plain ? value + "T00:00:00Z" : value, {
    date: "year",
    zone: plain ? "UTC" : undefined,
  });
}

/** "2026-10-22": the calendar day of a moment in a zone, for comparisons. */
export const dayInZone = (iso: string, zone: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: zone });

/** "1,204". */
export function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

/** "82.5%", or an em dash when there is nothing to measure. */
export function formatPercent(value: number | null) {
  return value === null ? "—" : `${value}%`;
}
