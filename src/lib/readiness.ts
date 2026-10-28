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

export async function readiness(user: string, carrierParam: string | null) {
  const carrierId = z.uuid().parse(carrierParam);
  return transaction(async (c) => {
    const m = await member(c, user, carrierId);
    const driverOnly = m.role === "driver";
    const loads = await c.query(
      `SELECT l.id,l.reference,l.stage,
         (SELECT to_char(min(e.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM load_events e
            WHERE e.load_id=l.id AND e.type='load.milestones' AND e.payload->>'stage'='delivered') delivered_on,
         (SELECT d.name FROM load_assignments a JOIN drivers d ON d.id=a.driver_id WHERE a.load_id=l.id) driver
       FROM loads l
       WHERE l.carrier_id=$1 AND l.cancelled_at IS NULL
         AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM load_assignments a WHERE a.load_id=l.id AND a.driver_id=$2))
       ORDER BY l.created_at DESC,l.id LIMIT 200`,
      [carrierId, driverOnly ? m.driver_id : null],
    );
    const slots = await loadDocumentSlotsFor(
      c,
      loads.rows.map((r) => r.id as string),
    );
    const today = new Date().toISOString().slice(0, 10);
    const out: ReadinessLoad[] = [];
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
      out.push({
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
    // Held-up billing first, longest waiting first.
    out.sort(
      (a, b) =>
        Number(b.blocks_billing) - Number(a.blocks_billing) ||
        (b.days_outstanding ?? -1) - (a.days_outstanding ?? -1) ||
        a.reference.localeCompare(b.reference),
    );
    return {
      carrier_id: carrierId,
      scope: driverOnly ? ("my_loads" as const) : ("carrier" as const),
      loads: out,
      summary: {
        loads: out.length,
        blocking_billing: out.filter((l) => l.blocks_billing).length,
        waiting_on_driver: out.filter((l) =>
          l.items.some((i) => i.owed_by === "driver"),
        ).length,
        waiting_on_dispatcher: out.filter((l) =>
          l.items.some((i) => i.owed_by === "dispatcher"),
        ).length,
      },
    };
  });
}
