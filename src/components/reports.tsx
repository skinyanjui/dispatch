"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { formatMoney } from "@/lib/entry";

type Timing = {
  measured: number;
  on_time: number;
  not_reported: number;
  on_time_pct: number | null;
};
type Report = {
  range: { from: string; to: string };
  generated_at: string;
  loads: {
    loads: number;
    cancelled: number;
    booked: number;
    dispatched: number;
    picked_up: number;
    delivered: number;
    freight_minor: string;
  };
  timing: { pickup: Timing; delivery: Timing };
  exceptions: {
    opened: number;
    open_now: number;
    overdue: number;
    by_type: {
      type: string;
      opened: number;
      open_now: number;
      overdue: number;
      avg_hours: number;
    }[];
  };
  delivered_without_pod: number;
  carriers: {
    id: string;
    name: string;
    loads: number;
    cancelled: number;
    delivered: number;
    freight_minor: string;
    open_exceptions: number;
  }[];
  weekly: { week: string; loads: number; freight_minor: string }[];
  dispatch_invoices: {
    issued: number;
    issued_minor: string;
    paid_minor: string;
    outstanding_minor: string;
    overdue: number;
  } | null;
  carrier_freight_billing: {
    submitted: number;
    billed_minor: string;
    received_minor: string;
    outstanding_minor: string;
  };
};
const typeLabels: Record<string, string> = {
  delay: "Delay",
  missed_appointment: "Missed appointment",
  missing_document: "Missing document",
  other: "Other",
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="reportTile">
      <small>{label}</small>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}
const pct = (t: Timing) => (t.on_time_pct === null ? "—" : `${t.on_time_pct}%`);
const timingHint = (t: Timing) =>
  `${t.on_time} of ${t.measured} reported on time` +
  (t.not_reported ? ` · ${t.not_reported} not reported` : "");

export function Reports({
  carriers,
  onAuthError,
}: {
  carriers: { id: string; name: string }[];
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [from, setFrom] = useState(() => daysAgo(29)),
    [to, setTo] = useState(() => iso(new Date())),
    [carrier, setCarrier] = useState(""),
    [data, setData] = useState<Report | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const request = useRef(0);
  const query = new URLSearchParams({
    from,
    to,
    ...(carrier ? { carrier_id: carrier } : {}),
  });
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<Report>(
        "reports?" +
          new URLSearchParams({
            from,
            to,
            ...(carrier ? { carrier_id: carrier } : {}),
          }),
      );
      if (id === request.current) setData(result);
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [api, from, to, carrier, onAuthError]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);
  const maxWeek = Math.max(1, ...(data?.weekly.map((w) => w.loads) ?? [1]));
  return (
    <section className="reports" aria-label="Reports">
      <div className="directoryIntro">
        <div>
          <h2>Reports</h2>
          <p>
            Here&apos;s how things are going. Pick a date range and we&apos;ll
            tally loads by first pickup (UTC dates). On-time counts arrivals
            people have reported; stops with no report are shown separately
            instead of being guessed.
          </p>
        </div>
        <a
          className="secondary"
          href={`/api/reports/loads.csv?${query}`}
          download
        >
          <DownloadSimpleIcon size={15} aria-hidden="true" /> Export loads (CSV)
        </a>
      </div>
      <div className="contactFilters">
        <label>
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>
        {[7, 30, 90].map((n) => (
          <button
            key={n}
            className="textButton"
            onClick={() => {
              setFrom(daysAgo(n - 1));
              setTo(iso(new Date()));
            }}
          >
            Last {n} days
          </button>
        ))}
        {carriers.length > 1 && (
          <label>
            Carrier
            <select
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
            >
              <option value="">All carriers</option>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <p className="srOnly" role="status">
        {loading ? "Loading report" : "Report loaded"}
      </p>
      {loading && !data && <p>Loading report…</p>}
      {data && (
        <div aria-busy={loading}>
          <div className="reportTiles">
            <Tile
              label="Loads"
              value={String(data.loads.loads)}
              hint={`${data.loads.delivered} delivered · ${data.loads.cancelled} cancelled`}
            />
            <Tile
              label="Freight value"
              value={formatMoney(data.loads.freight_minor)}
              hint="Agreed rates, excluding cancelled"
            />
            <Tile
              label="Pickups on time"
              value={pct(data.timing.pickup)}
              hint={timingHint(data.timing.pickup)}
            />
            <Tile
              label="Deliveries on time"
              value={pct(data.timing.delivery)}
              hint={timingHint(data.timing.delivery)}
            />
            <Tile
              label="Open exceptions"
              value={String(data.exceptions.open_now)}
              hint={`${data.exceptions.overdue} overdue · ${data.exceptions.opened} opened`}
            />
            <Tile
              label="Delivered, no accepted POD"
              value={String(data.delivered_without_pod)}
            />
          </div>
          <h3>Pipeline</h3>
          <p className="helpText">
            {data.loads.booked} booked · {data.loads.dispatched} dispatched ·{" "}
            {data.loads.picked_up} in transit · {data.loads.delivered} delivered
          </p>
          {data.weekly.length > 0 && (
            <>
              <h3>Loads by pickup week</h3>
              <ol className="weekBars" aria-label="Loads by pickup week">
                {data.weekly.map((w) => (
                  <li key={w.week}>
                    <span>Week of {w.week}</span>
                    <span
                      className="bar"
                      style={{ width: `${(w.loads / maxWeek) * 100}%` }}
                      aria-hidden="true"
                    />
                    <strong>
                      {w.loads} · {formatMoney(w.freight_minor)}
                    </strong>
                  </li>
                ))}
              </ol>
            </>
          )}
          <h3>By carrier</h3>
          <div
            className="tableScroll"
            role="region"
            aria-label="By carrier"
            tabIndex={0}
          >
            <table className="reportTable">
              <thead>
                <tr>
                  <th scope="col">Carrier</th>
                  <th scope="col">Loads</th>
                  <th scope="col">Delivered</th>
                  <th scope="col">Cancelled</th>
                  <th scope="col">Freight</th>
                  <th scope="col">Open exceptions</th>
                </tr>
              </thead>
              <tbody>
                {data.carriers.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.name}</th>
                    <td>{c.loads}</td>
                    <td>{c.delivered}</td>
                    <td>{c.cancelled}</td>
                    <td>{formatMoney(c.freight_minor)}</td>
                    <td>{c.open_exceptions}</td>
                  </tr>
                ))}
                {!data.carriers.length && (
                  <tr>
                    <td colSpan={6}>No loads in this range.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data.exceptions.by_type.length > 0 && (
            <>
              <h3>Exceptions</h3>
              <div
                className="tableScroll"
                role="region"
                aria-label="Exceptions"
                tabIndex={0}
              >
                <table className="reportTable">
                  <thead>
                    <tr>
                      <th scope="col">Type</th>
                      <th scope="col">Opened</th>
                      <th scope="col">Open now</th>
                      <th scope="col">Overdue</th>
                      <th scope="col">Avg. hours to resolve</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.exceptions.by_type.map((x) => (
                      <tr key={x.type}>
                        <th scope="row">{typeLabels[x.type] ?? x.type}</th>
                        <td>{x.opened}</td>
                        <td>{x.open_now}</td>
                        <td>{x.overdue}</td>
                        <td>{x.avg_hours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h3>Billing</h3>
          <div className="reportTiles">
            {data.dispatch_invoices && (
              <>
                <Tile
                  label="Dispatch invoices issued"
                  value={formatMoney(data.dispatch_invoices.issued_minor)}
                  hint={`${data.dispatch_invoices.issued} invoices in range`}
                />
                <Tile
                  label="Dispatch fees outstanding"
                  value={formatMoney(data.dispatch_invoices.outstanding_minor)}
                  hint={`${data.dispatch_invoices.overdue} overdue · ${formatMoney(data.dispatch_invoices.paid_minor)} paid`}
                />
              </>
            )}
            <Tile
              label="Carrier freight billed"
              value={formatMoney(data.carrier_freight_billing.billed_minor)}
              hint={`${data.carrier_freight_billing.submitted} packets submitted`}
            />
            <Tile
              label="Carrier freight outstanding"
              value={formatMoney(
                data.carrier_freight_billing.outstanding_minor,
              )}
              hint="Reported by carriers; Relay holds no freight funds"
            />
          </div>
          <p className="helpText">
            Generated {new Date(data.generated_at).toLocaleString()} from live
            records.
          </p>
        </div>
      )}
    </section>
  );
}
