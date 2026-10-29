import { z } from "zod";
import { transaction } from "./db";
import { member } from "./loads";
import { acceptedCurrentDocument } from "./document-readiness";
import {
  averageDays,
  cashStage,
  daysBetween,
  feeOf,
  netOf,
  paidOn,
  type CashStage,
  type WaitingOn,
} from "./cash";

/**
 * What each load earned for the carrier after the dispatch fee, and how long
 * the money is taking (ADR 0066). The fee is the real one when the load is on
 * a dispatch invoice, an estimate when the person previews a percentage, and
 * unknown otherwise: a net figure is never invented.
 */
export type CashLoad = {
  id: string;
  reference: string;
  gross_minor: string;
  fee: {
    state: "invoiced" | "estimate" | "unknown";
    minor: string | null;
    bps: number | null;
    invoice_number: string | null;
  };
  net_minor: string | null;
  cash_stage: CashStage;
  waiting_on: WaitingOn;
  payer: string | null;
  delivered_on: string | null;
  packet_submitted_on: string | null;
  paid_on: string | null;
  paid_minor: string;
  owed_minor: string | null;
  days: {
    delivery_to_submit: number | null;
    submit_to_paid: number | null;
    to_cash: number | null;
    waiting: number | null;
  };
};

const query = z
  .object({
    carrier_id: z.uuid(),
    fee_bps: z.coerce.number().int().min(0).max(10000).nullable(),
    as_of: z.iso.date().nullable(),
  })
  .strict();

/** Loads read for the figures, and loads listed (ADR 0071). */
const defaultLimits = { readLimit: 5000, listLimit: 200 };

export async function cashOverview(
  user: string,
  params: URLSearchParams,
  limits: Partial<typeof defaultLimits> = {},
) {
  const { readLimit, listLimit } = { ...defaultLimits, ...limits };
  const q = query.parse({
    carrier_id: params.get("carrier_id"),
    fee_bps: params.get("fee_bps"),
    as_of: params.get("as_of"),
  });
  const asOf = q.as_of ?? new Date().toISOString().slice(0, 10);
  return transaction(async (c) => {
    await member(c, user, q.carrier_id, true);
    const loads = await c.query(
      `SELECT l.id,l.reference,l.amount_minor::text gross,
         (SELECT to_char(min(e.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM load_events e
            WHERE e.load_id=l.id AND e.type='load.milestones' AND e.payload->>'stage'='delivered') delivered_on,
         ${acceptedCurrentDocument("l", "pod")} pod_accepted,
         p.bill_to,p.status packet_status,p.amount_minor::text packet_amount,
         to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD') submitted_on,
         (SELECT COALESCE(sum(r.amount_minor),0)::text FROM carrier_payment_receipts r WHERE r.load_id=l.id) paid,
         dl.fee_minor::text invoiced_fee,i.fee_bps invoiced_bps,i.number invoice_number
       FROM loads l
       LEFT JOIN carrier_billing_packets p ON p.load_id=l.id
       LEFT JOIN dispatch_invoice_lines dl ON dl.load_id=l.id AND dl.active
       LEFT JOIN dispatch_invoices i ON i.id=dl.invoice_id AND i.status<>'void'
       WHERE l.carrier_id=$1 AND l.cancelled_at IS NULL AND l.stage='delivered'
       ORDER BY l.created_at DESC,l.id LIMIT $2`,
      [q.carrier_id, readLimit + 1],
    );
    // One more than the ceiling is read, only to know the ceiling was hit.
    const totalsPartial = loads.rows.length > readLimit;
    loads.rows = loads.rows.slice(0, readLimit);
    const ids = loads.rows.map((r) => r.id as string);
    const receipts = ids.length
      ? await c.query(
          `SELECT load_id,amount_minor::text,to_char(received_on,'YYYY-MM-DD') received_on
           FROM carrier_payment_receipts WHERE load_id=ANY($1::uuid[])`,
          [ids],
        )
      : {
          rows: [] as {
            load_id: string;
            amount_minor: string;
            received_on: string;
          }[],
        };
    const out: CashLoad[] = loads.rows.map((r) => {
      const mine = receipts.rows.filter((x) => x.load_id === r.id);
      const stage = cashStage({
        delivered: true,
        pod_accepted: r.pod_accepted,
        packet_amount_minor: r.packet_amount,
        packet_submitted: r.packet_status === "submitted",
        paid_minor: r.paid,
      });
      const fee: CashLoad["fee"] = r.invoiced_fee
        ? {
            state: "invoiced",
            minor: r.invoiced_fee,
            bps: r.invoiced_bps,
            invoice_number: r.invoice_number,
          }
        : q.fee_bps !== null
          ? {
              state: "estimate",
              minor: feeOf(r.gross, q.fee_bps),
              bps: q.fee_bps,
              invoice_number: null,
            }
          : { state: "unknown", minor: null, bps: null, invoice_number: null };
      const paid_on = paidOn(r.packet_amount, mine);
      const delivered_on: string | null = r.delivered_on;
      const since = r.submitted_on ?? delivered_on;
      return {
        id: r.id,
        reference: r.reference,
        gross_minor: r.gross,
        fee,
        net_minor: fee.minor === null ? null : netOf(r.gross, fee.minor),
        cash_stage: stage.stage,
        waiting_on: stage.waiting_on,
        payer: r.bill_to ?? null,
        delivered_on,
        packet_submitted_on: r.submitted_on ?? null,
        paid_on,
        paid_minor: r.paid,
        owed_minor: r.packet_amount
          ? BigInt(r.packet_amount) > BigInt(r.paid)
            ? (BigInt(r.packet_amount) - BigInt(r.paid)).toString()
            : "0"
          : null,
        days: {
          delivery_to_submit:
            delivered_on && r.submitted_on
              ? daysBetween(delivered_on, r.submitted_on)
              : null,
          submit_to_paid:
            r.submitted_on && paid_on
              ? daysBetween(r.submitted_on, paid_on)
              : null,
          to_cash:
            delivered_on && paid_on ? daysBetween(delivered_on, paid_on) : null,
          waiting:
            stage.stage === "paid" || !since ? null : daysBetween(since, asOf),
        },
      };
    });
    const sum = (f: (l: CashLoad) => string | null) =>
      out.reduce((t, l) => t + BigInt(f(l) ?? "0"), 0n).toString();
    const known = out.filter((l) => l.net_minor !== null);
    return {
      carrier_id: q.carrier_id,
      as_of: asOf,
      fee_bps_preview: q.fee_bps,
      loads: out.slice(0, listLimit),
      // The list shows the newest; the figures below count every load read.
      list_truncated: out.length > listLimit,
      totals_partial: totalsPartial,
      summary: {
        loads: out.length,
        gross_minor: sum((l) => l.gross_minor),
        // Net counts only loads whose fee is known (invoiced, or previewed).
        net_loads: known.length,
        fee_minor: known
          .reduce((t, l) => t + BigInt(l.fee.minor!), 0n)
          .toString(),
        net_minor: known
          .reduce((t, l) => t + BigInt(l.net_minor!), 0n)
          .toString(),
        outstanding_minor: sum((l) =>
          l.cash_stage === "paid" ? null : l.owed_minor,
        ),
        unpaid: out.filter((l) => l.cash_stage !== "paid").length,
        paid: out.filter((l) => l.cash_stage === "paid").length,
        avg_days_to_cash: averageDays(
          out.flatMap((l) => (l.days.to_cash === null ? [] : [l.days.to_cash])),
        ),
        oldest_waiting_days: out.reduce<number | null>(
          (m, l) =>
            l.days.waiting === null ? m : Math.max(m ?? 0, l.days.waiting),
          null,
        ),
      },
    };
  });
}
