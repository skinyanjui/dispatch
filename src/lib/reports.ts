import { z } from "zod";
import { pool } from "./db";
import { HttpError } from "./auth";

// Read-only reporting (ADR 0024). Every figure is computed from the records
// that already exist, for the carriers the caller manages or dispatches, over
// loads whose first pickup window starts in the chosen UTC date range. Every
// boundary is spelled out in UTC so the database session timezone never shifts it.

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)));
const filters = z
  .object({
    from: date.optional(),
    to: date.optional(),
    carrier_id: z.uuid().optional(),
  })
  .strict();
const maxDays = 366;

function range(params: URLSearchParams) {
  const f = filters.parse({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    carrier_id: params.get("carrier_id") ?? undefined,
  });
  const today = new Date().toISOString().slice(0, 10);
  const to = f.to ?? today;
  const from =
    f.from ??
    new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0 || days > maxDays) throw new HttpError(422, "INVALID_RANGE");
  return { from, to, carrier: f.carrier_id ?? null };
}

/** Loads in range for carriers the caller works as dispatcher or carrier manager. */
const scope = `
  SELECT l.*,f.window_start pickup_at,m.role
  FROM loads l
  JOIN memberships m ON m.carrier_id=l.carrier_id AND m.user_id=$1 AND m.role<>'driver'
  JOIN LATERAL (SELECT window_start FROM load_stops WHERE load_id=l.id AND sequence=1) f ON true
  WHERE ($2::uuid IS NULL OR l.carrier_id=$2)
    AND f.window_start>=($3::date::timestamp AT TIME ZONE 'UTC')
    AND f.window_start<(($4::date+1)::timestamp AT TIME ZONE 'UTC')`;

async function authorize(user: string, carrier: string | null) {
  const { rows } = await pool.query(
    "SELECT carrier_id,role FROM memberships WHERE user_id=$1 AND role<>'driver'",
    [user],
  );
  if (!rows.length || (carrier && !rows.some((r) => r.carrier_id === carrier)))
    throw new HttpError(404, "NOT_FOUND");
  return rows as { carrier_id: string; role: string }[];
}

const pct = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : null;

export async function reportOverview(user: string, params: URLSearchParams) {
  const r = range(params);
  const memberships = await authorize(user, r.carrier);
  const args = [user, r.carrier, r.from, r.to];
  const q = (sql: string) => pool.query(sql, args);
  const [
    summary,
    timing,
    exceptions,
    pods,
    perCarrier,
    weekly,
    invoices,
    freight,
  ] = await Promise.all([
    q(`WITH s AS (${scope}) SELECT
        count(*) FILTER (WHERE cancelled_at IS NULL)::int loads,
        count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int cancelled,
        count(*) FILTER (WHERE cancelled_at IS NULL AND stage='booked')::int booked,
        count(*) FILTER (WHERE cancelled_at IS NULL AND stage='dispatched')::int dispatched,
        count(*) FILTER (WHERE cancelled_at IS NULL AND stage='picked-up')::int picked_up,
        count(*) FILTER (WHERE cancelled_at IS NULL AND stage='delivered')::int delivered,
        COALESCE(sum(amount_minor) FILTER (WHERE cancelled_at IS NULL),0)::text freight_minor FROM s`),
    q(`WITH s AS (${scope}) SELECT st.kind,
        count(e.id)::int measured,
        count(e.id) FILTER (WHERE e.occurred_at<=st.window_end)::int on_time,
        count(*) FILTER (WHERE e.id IS NULL AND st.window_end<now())::int not_reported
        FROM s JOIN load_stops st ON st.load_id=s.id
        LEFT JOIN stop_events e ON e.stop_id=st.id AND e.kind='arrived'
          AND NOT EXISTS(SELECT 1 FROM stop_events x WHERE x.supersedes=e.id)
        WHERE s.cancelled_at IS NULL GROUP BY st.kind`),
    q(`WITH s AS (${scope}) SELECT x.type,
        count(*)::int opened,
        count(*) FILTER (WHERE x.status<>'resolved')::int open_now,
        count(*) FILTER (WHERE x.status<>'resolved' AND x.due_at<now())::int overdue,
        COALESCE(round(avg(extract(epoch FROM x.resolved_at-x.opened_at)/3600) FILTER (WHERE x.status='resolved')::numeric,1),0)::float avg_hours
        FROM s JOIN load_exceptions x ON x.load_id=s.id GROUP BY x.type ORDER BY x.type`),
    q(`WITH s AS (${scope}) SELECT count(*)::int n FROM s
        WHERE s.cancelled_at IS NULL AND s.stage='delivered'
        AND NOT EXISTS(SELECT 1 FROM documents d JOIN document_versions v ON v.document_id=d.id
          JOIN document_reviews rv ON rv.version_id=v.id AND rv.decision='accepted'
          WHERE d.load_id=s.id AND d.type='pod')`),
    q(`WITH s AS (${scope}) SELECT c.id,c.name,
        count(*) FILTER (WHERE s.cancelled_at IS NULL)::int loads,
        count(*) FILTER (WHERE s.cancelled_at IS NOT NULL)::int cancelled,
        count(*) FILTER (WHERE s.cancelled_at IS NULL AND s.stage='delivered')::int delivered,
        COALESCE(sum(s.amount_minor) FILTER (WHERE s.cancelled_at IS NULL),0)::text freight_minor,
        (SELECT count(*)::int FROM load_exceptions x WHERE x.carrier_id=c.id AND x.status<>'resolved') open_exceptions
        FROM s JOIN carriers c ON c.id=s.carrier_id GROUP BY c.id,c.name ORDER BY c.name`),
    q(`WITH s AS (${scope}) SELECT to_char(date_trunc('week',pickup_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') week,
        count(*)::int loads, COALESCE(sum(amount_minor),0)::text freight_minor
        FROM s WHERE cancelled_at IS NULL GROUP BY 1 ORDER BY 1`),
    // Relay's own fee invoices: dispatchers only, by issue date in range.
    pool.query(
      `SELECT count(*)::int issued,
          COALESCE(sum(i.total_minor),0)::text issued_minor,
          COALESCE(sum(p.paid),0)::text paid_minor,
          COALESCE(sum(i.total_minor-COALESCE(p.paid,0)),0)::text outstanding_minor,
          count(*) FILTER (WHERE i.due_on<(now() AT TIME ZONE 'UTC')::date AND i.total_minor>COALESCE(p.paid,0))::int overdue
        FROM dispatch_invoices i
        LEFT JOIN LATERAL (SELECT sum(amount_minor) paid FROM dispatch_invoice_payments WHERE invoice_id=i.id) p ON true
        WHERE i.status='issued' AND i.issued_at>=($3::date::timestamp AT TIME ZONE 'UTC')
          AND i.issued_at<(($4::date+1)::timestamp AT TIME ZONE 'UTC')
          AND ($2::uuid IS NULL OR i.carrier_id=$2)
          AND i.carrier_id IN (SELECT carrier_id FROM memberships WHERE user_id=$1 AND role='dispatcher')`,
      args,
    ),
    // Carrier freight billing reported to Relay, for loads in range.
    q(`WITH s AS (${scope}) SELECT count(*)::int submitted,
        COALESCE(sum(p.amount_minor),0)::text billed_minor,
        COALESCE(sum(rc.received),0)::text received_minor,
        COALESCE(sum(p.amount_minor-COALESCE(rc.received,0)),0)::text outstanding_minor
        FROM s JOIN carrier_billing_packets p ON p.load_id=s.id AND p.status='submitted'
        LEFT JOIN LATERAL (SELECT sum(amount_minor) received FROM carrier_payment_receipts WHERE load_id=s.id) rc ON true
        WHERE s.cancelled_at IS NULL`),
  ]);
  const by = (kind: string) => timing.rows.find((t) => t.kind === kind);
  const stat = (k: string) => {
    const t = by(k);
    return {
      measured: t?.measured ?? 0,
      on_time: t?.on_time ?? 0,
      not_reported: t?.not_reported ?? 0,
      on_time_pct: pct(t?.on_time ?? 0, t?.measured ?? 0),
    };
  };
  const dispatcherView = memberships.some(
    (m) =>
      m.role === "dispatcher" && (!r.carrier || m.carrier_id === r.carrier),
  );
  return {
    range: { from: r.from, to: r.to, carrier_id: r.carrier },
    generated_at: new Date().toISOString(),
    loads: summary.rows[0],
    timing: { pickup: stat("pickup"), delivery: stat("delivery") },
    exceptions: {
      by_type: exceptions.rows,
      opened: exceptions.rows.reduce((n, x) => n + x.opened, 0),
      open_now: exceptions.rows.reduce((n, x) => n + x.open_now, 0),
      overdue: exceptions.rows.reduce((n, x) => n + x.overdue, 0),
    },
    delivered_without_pod: pods.rows[0].n,
    carriers: perCarrier.rows,
    weekly: weekly.rows,
    dispatch_invoices: dispatcherView ? invoices.rows[0] : null,
    carrier_freight_billing: freight.rows[0],
  };
}

// ---------- CSV export ----------

/** Spreadsheet formulas in cells are neutralised; quotes are doubled. */
export function csvCell(value: unknown) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
const money = (minor: string) =>
  `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, "0")}`;

export async function loadsCsv(user: string, params: URLSearchParams) {
  const r = range(params);
  await authorize(user, r.carrier);
  const { rows } = await pool.query(
    `WITH s AS (${scope})
    SELECT s.reference,c.name carrier,
      CASE WHEN s.cancelled_at IS NOT NULL THEN 'cancelled' ELSE s.stage END status,
      to_char(s.pickup_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') pickup_utc,
      (SELECT address FROM load_stops WHERE load_id=s.id AND sequence=1) pickup,
      (SELECT address FROM load_stops WHERE load_id=s.id ORDER BY sequence DESC LIMIT 1) delivery,
      s.amount_minor::text amount_minor, d.name driver,
      (SELECT count(*)::int FROM load_exceptions x WHERE x.load_id=s.id) exceptions,
      s.cancel_reason
    FROM s JOIN carriers c ON c.id=s.carrier_id
    LEFT JOIN load_assignments a ON a.load_id=s.id LEFT JOIN drivers d ON d.id=a.driver_id
    ORDER BY s.pickup_at,s.reference LIMIT 5000`,
    [user, r.carrier, r.from, r.to],
  );
  const head = [
    "Reference",
    "Carrier",
    "Status",
    "Pickup (UTC)",
    "Pickup address",
    "Delivery address",
    "Agreed rate (USD)",
    "Driver",
    "Exceptions",
    "Cancel reason",
  ];
  const lines = [head.map(csvCell).join(",")];
  for (const x of rows)
    lines.push(
      [
        x.reference,
        x.carrier,
        x.status,
        x.pickup_utc,
        x.pickup,
        x.delivery,
        money(x.amount_minor),
        x.driver,
        x.exceptions,
        x.cancel_reason,
      ]
        .map(csvCell)
        .join(","),
    );
  await pool.query(
    "INSERT INTO audit_logs VALUES(gen_random_uuid(),$1,'report.exported',$2,now())",
    [user, `loads ${r.from}..${r.to} (${rows.length})`],
  );
  return {
    csv: lines.join("\r\n") + "\r\n",
    filename: `relay-loads-${r.from}-to-${r.to}.csv`,
    truncated: rows.length === 5000,
  };
}
