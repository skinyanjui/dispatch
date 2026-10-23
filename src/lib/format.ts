// One formatting strategy for values shown in the interface (design system,
// docs/design-system.md). Money is integer minor units (ADR 0009); dates are
// ISO strings shown in the viewer's time zone unless a zone is given.
import { formatMoney } from "./entry";

export { formatMoney };

/** "Oct 22, 11:45 PM": when something happened, this year. */
export function formatDateTime(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** "Oct 22, 2026, 11:45 PM": a record date that may be from another year. */
export function formatDateTimeLong(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Oct 22, 2026" for an ISO date or timestamp. A plain date is read as UTC. */
export function formatDate(value: string) {
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Date(plain ? value + "T00:00:00Z" : value).toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
      ...(plain ? { timeZone: "UTC" } : {}),
    },
  );
}

/** "1,204". */
export function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

/** "82.5%", or an em dash when there is nothing to measure. */
export function formatPercent(value: number | null) {
  return value === null ? "—" : `${value}%`;
}
