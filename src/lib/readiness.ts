import { z } from "zod";
import { transaction } from "./db";
import { member } from "./loads";
import { loadDocumentSlotsFor } from "./documents";
import { loadDocumentTypes } from "./compliance";
import { readinessItem, type ReadinessItem } from "./readiness-rules";

/**
 * Which loads are held up by paperwork, and who has to act (ADR 0068).
 * Dispatchers and carrier managers see the carrier's loads; a driver sees only
 * their assigned loads and only the items that wait on drivers.
 */
export type ReadinessLoad = {
  id: string;
  reference: string;
  stage: string;
  delivered: boolean;
  delivered_on: string | null;
  days_outstanding: number | null;
  driver: string | null;
  items: ReadinessItem[];
  blocks_billing: boolean;
};

/** How many loads are read, and how many held-up loads are returned (ADR 0071). */
const defaultLimits = { batchSize: 400, scanLimit: 4000, returnLimit: 200 };

export async function readiness(
  user: string,
  carrierParam: string | null,
  limits: Partial<typeof defaultLimits> = {},
) {
  const { batchSize, scanLimit, returnLimit } = { ...defaultLimits, ...limits };
  const carrierId = z.uuid().parse(carrierParam);
  return transaction(async (c) => {
    const m = await member(c, user, carrierId);
    const driverOnly = m.role === "driver";
    const today = new Date().toISOString().slice(0, 10);
    const all: ReadinessLoad[] = [];
    // Held-up loads are found among all of the carrier's loads, newest first,
    // in batches: a limit applied before looking at documents would hide an
    // old load that is still waiting. Reading stops at a ceiling, and says so.
    let cursor: { at: string; id: string } | null = null;
    let scanned = 0;
    let scanTruncated = false;
    for (;;) {
      const loads: { rows: Record<string, any>[] } = await c.query(
        `SELECT l.id,l.reference,l.stage,l.created_at::text cursor_at,
           (SELECT to_char(min(e.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM load_events e
              WHERE e.load_id=l.id AND e.type='load.milestones' AND e.payload->>'stage'='delivered') delivered_on,
           (SELECT d.name FROM load_assignments a JOIN drivers d ON d.id=a.driver_id WHERE a.load_id=l.id) driver
         FROM loads l
         WHERE l.carrier_id=$1 AND l.cancelled_at IS NULL
           AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM load_assignments a WHERE a.load_id=l.id AND a.driver_id=$2))
           AND ($3::timestamptz IS NULL OR (l.created_at,l.id)<($3::timestamptz,$4::uuid))
         ORDER BY l.created_at DESC,l.id DESC LIMIT $5`,
        [
          carrierId,
          driverOnly ? m.driver_id : null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          batchSize,
        ],
      );
      if (!loads.rows.length) break;
      const slots = await loadDocumentSlotsFor(
        c,
        loads.rows.map((r) => r.id as string),
      );
      for (const r of loads.rows) {
        const delivered = r.stage === "delivered";
        let items = loadDocumentTypes.map((type) =>
          readinessItem(
            type,
            slots.get(r.id)!.find((s) => s.type === type)!.status,
            delivered,
          ),
        );
        if (driverOnly) items = items.filter((i) => i.owed_by === "driver");
        const open = items.filter((i) => i.owed_by !== "none");
        if (!open.length) continue;
        all.push({
          id: r.id,
          reference: r.reference,
          stage: r.stage,
          delivered,
          delivered_on: r.delivered_on,
          days_outstanding: r.delivered_on
            ? Math.max(
                0,
                Math.floor(
                  (Date.parse(today) - Date.parse(r.delivered_on)) / 864e5,
                ),
              )
            : null,
          driver: r.driver,
          items: open,
          blocks_billing: open.some((i) => i.blocks_billing),
        });
      }
      scanned += loads.rows.length;
      const last = loads.rows[loads.rows.length - 1];
      cursor = { at: last.cursor_at, id: last.id };
      if (loads.rows.length < batchSize) break;
      if (scanned >= scanLimit) {
        scanTruncated = true;
        break;
      }
    }
    // Held-up billing first, longest waiting first.
    all.sort(
      (a, b) =>
        Number(b.blocks_billing) - Number(a.blocks_billing) ||
        (b.days_outstanding ?? -1) - (a.days_outstanding ?? -1) ||
        a.reference.localeCompare(b.reference),
    );
    return {
      carrier_id: carrierId,
      scope: driverOnly ? ("my_loads" as const) : ("carrier" as const),
      loads: all.slice(0, returnLimit),
      // The figures cover every held-up load found, not only those listed.
      list_truncated: all.length > returnLimit,
      scan_truncated: scanTruncated,
      loads_scanned: scanned,
      summary: {
        loads: all.length,
        blocking_billing: all.filter((l) => l.blocks_billing).length,
        waiting_on_driver: all.filter((l) =>
          l.items.some((i) => i.owed_by === "driver"),
        ).length,
        waiting_on_dispatcher: all.filter((l) =>
          l.items.some((i) => i.owed_by === "dispatcher"),
        ).length,
      },
    };
  });
}
