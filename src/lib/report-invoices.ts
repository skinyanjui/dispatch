import { z } from "zod";
import { transaction } from "./db";
import { HttpError } from "./auth";
import { pickupRange } from "./reporting-scope";
import { decodeCursor, encodeCursor, pgTimestamp } from "./loads";

/** Fee invoice drill-down: issue-date cohort, current recorded balances. */
export async function reportInvoices(user: string, params: URLSearchParams) {
  const range = pickupRange(params, true);
  const carrier = z.uuid().nullable().parse(params.get("carrier_id"));
  const outstanding = z
    .enum(["outstanding"])
    .nullable()
    .parse(params.get("balance"));
  const cursor = params.get("cursor")
    ? decodeCursor(
        params.get("cursor")!,
        z.object({ at: pgTimestamp, id: z.uuid() }),
      )
    : null;
  return transaction(async (c) => {
    const allowed = await c.query(
      "SELECT carrier_id FROM memberships WHERE user_id=$1 AND role='dispatcher' AND ($2::uuid IS NULL OR carrier_id=$2)",
      [user, carrier],
    );
    if (!allowed.rowCount) throw new HttpError(404, "NOT_FOUND");
    const result = await c.query(
      `SELECT i.id,i.number,c.name carrier_name,i.total_minor::text,
      COALESCE(p.paid,0)::text paid_minor,(i.total_minor-COALESCE(p.paid,0))::text outstanding_minor,
      i.issued_at::text cursor_at,i.issued_at,to_char(i.due_on,'YYYY-MM-DD') due_on
      FROM dispatch_invoices i JOIN carriers c ON c.id=i.carrier_id
      LEFT JOIN LATERAL(SELECT sum(amount_minor) paid FROM dispatch_invoice_payments WHERE invoice_id=i.id) p ON true
      WHERE i.carrier_id=ANY($1::uuid[]) AND i.status='issued'
      AND i.issued_at>=($2::date::timestamp AT TIME ZONE 'UTC') AND i.issued_at<(($3::date+1)::timestamp AT TIME ZONE 'UTC')
      AND ($4::boolean=false OR i.total_minor>COALESCE(p.paid,0))
      AND ($5::timestamptz IS NULL OR i.issued_at<$5 OR (i.issued_at=$5 AND i.id>$6::uuid))
      ORDER BY i.issued_at DESC,i.id LIMIT 101`,
      [
        allowed.rows.map((r) => r.carrier_id),
        range.from,
        range.to,
        !!outstanding,
        cursor?.at ?? null,
        cursor?.id ?? null,
      ],
    );
    const rows = result.rows.slice(0, 100),
      last = rows.at(-1);
    return {
      invoices: rows,
      nextCursor:
        result.rows.length > 100 && last
          ? encodeCursor({ at: last.cursor_at, id: last.id })
          : null,
    };
  }, "repeatable read");
}
