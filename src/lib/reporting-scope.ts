import { z } from "zod";
import { HttpError } from "./auth";

export const calendarDate = z.iso.date();
export function pickupRange(params: URLSearchParams, defaults = false) {
  let from = calendarDate.optional().parse(params.get("from") ?? undefined);
  let to = calendarDate.optional().parse(params.get("to") ?? undefined);
  if (defaults) {
    to ??= new Date().toISOString().slice(0, 10);
    from ??= new Date(Date.parse(to) - 29 * 86400000)
      .toISOString()
      .slice(0, 10);
  }
  if (from && to) {
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days < 0 || days > 366) throw new HttpError(422, "INVALID_RANGE");
  }
  return { from: from ?? null, to: to ?? null };
}

/** Inclusive UTC calendar dates; the first ordered pickup defines the cohort. */
export const pickupCohort = (load: string, from: string, to: string) => `
  EXISTS(SELECT 1 FROM load_stops cohort WHERE cohort.load_id=${load}.id AND cohort.sequence=1
    AND (${from}::date IS NULL OR cohort.window_start>=(${from}::date::timestamp AT TIME ZONE 'UTC'))
    AND (${to}::date IS NULL OR cohort.window_start<((${to}::date+1)::timestamp AT TIME ZONE 'UTC')))`;
