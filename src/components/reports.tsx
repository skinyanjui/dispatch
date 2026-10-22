"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { formatMoney } from "@/lib/entry";
import type { AttentionKey } from "@/lib/attention";

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
const DAY = 86400000;
const presets = [7, 30, 90] as const;
const pageSize = 15;

export type OpenLoads = {
  carrier?: string;
  status?: string;
  attention?: AttentionKey;
};

/** The range just before this one, the same number of days long. */
function previousRange(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  const prevTo = iso(new Date(Date.parse(from) - DAY));
  const prevFrom = iso(new Date(Date.parse(prevTo) - (days - 1) * DAY));
  return { from: prevFrom, to: prevTo };
}

/** "+12%" or "−3 pts" against the previous period; nothing when unknown. */
function Delta({
  now,
  before,
  unit = "pct",
}: {
  now: number | null;
  before: number | null | undefined;
  unit?: "pct" | "pts";
}) {
  if (now === null || before === null || before === undefined) return null;
  const diff =
    unit === "pts"
      ? now - before
      : before === 0
        ? null
        : ((now - before) / before) * 100;
  if (diff === null || Math.abs(diff) < 0.5)
    return <small className="reportDelta">No change vs previous period</small>;
  const up = diff > 0;
  const text =
    (up ? "+" : "−") +
    Math.abs(Math.round(diff)) +
    (unit === "pts" ? " pts" : "%");
  return (
    <small className={"reportDelta " + (up ? "up" : "down")}>
      {up ? (
        <ArrowUpIcon size={11} aria-hidden="true" />
      ) : (
        <ArrowDownIcon size={11} aria-hidden="true" />
      )}
      {text} vs previous period
    </small>
  );
}

function Tile({
  label,
  value,
  hint,
  delta,
  onOpen,
  openLabel,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: React.ReactNode;
  onOpen?: () => void;
  openLabel?: string;
}) {
  const inner = (
    <>
      <small>{label}</small>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
      {delta}
      {onOpen && (
        <span className="reportOpen" aria-hidden="true">
          {openLabel} <CaretRightIcon size={11} />
        </span>
      )}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="reportTile link"
      onClick={onOpen}
      aria-label={`${label}: ${value}. ${openLabel}`}
    >
      {inner}
    </button>
  ) : (
    <div className="reportTile">{inner}</div>
  );
}
const pct = (t: Timing) => (t.on_time_pct === null ? "—" : `${t.on_time_pct}%`);
const timingHint = (t: Timing) =>
  `${t.on_time} of ${t.measured} reported on time` +
  (t.not_reported ? ` · ${t.not_reported} not reported` : "");

type SortKey =
  | "name"
  | "loads"
  | "delivered"
  | "cancelled"
  | "freight"
  | "open";
const sortColumns: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Carrier", numeric: false },
  { key: "loads", label: "Loads", numeric: true },
  { key: "delivered", label: "Delivered", numeric: true },
  { key: "cancelled", label: "Cancelled", numeric: true },
  { key: "freight", label: "Freight", numeric: true },
  { key: "open", label: "Open exceptions", numeric: true },
];

export function Reports({
  carriers,
  onAuthError,
  onOpenLoads,
  onOpenExceptions,
  onOpenBilling,
  query: search = "",
}: {
  carriers: { id: string; name: string }[];
  onAuthError: (e: unknown) => void;
  /** Jump to the Loads board with this scope. */
  onOpenLoads?: (scope: OpenLoads) => void;
  onOpenExceptions?: () => void;
  onOpenBilling?: () => void;
  /** Search text from the sidebar; filters the by-carrier table. */
  query?: string;
}) {
  const api = useApi();
  const [from, setFrom] = useState(() => daysAgo(29)),
    [to, setTo] = useState(() => iso(new Date())),
    [custom, setCustom] = useState(false),
    [carrier, setCarrier] = useState(""),
    [data, setData] = useState<Report | null>(null),
    [before, setBefore] = useState<Report | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
      key: "loads",
      desc: true,
    }),
    [shown, setShown] = useState(pageSize);
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
    const scope: Record<string, string> = carrier
      ? { carrier_id: carrier }
      : {};
    const prev = previousRange(from, to);
    // The earlier period is context only; if it fails the deltas just go away.
    const earlier = api<Report>(
      "reports?" + new URLSearchParams({ ...prev, ...scope }),
    ).catch(() => null);
    try {
      const result = await api<Report>(
        "reports?" + new URLSearchParams({ from, to, ...scope }),
      );
      const previous = await earlier;
      if (id === request.current) {
        setData(result);
        setBefore(previous);
      }
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
  const activePreset = custom
    ? null
    : presets.find((n) => from === daysAgo(n - 1) && to === iso(new Date()));
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (data?.carriers ?? []).filter((c) =>
      c.name.toLowerCase().includes(needle),
    );
    const value = (c: Report["carriers"][number]) =>
      sort.key === "name"
        ? c.name.toLowerCase()
        : sort.key === "freight"
          ? Number(c.freight_minor)
          : sort.key === "open"
            ? c.open_exceptions
            : c[sort.key];
    return [...list].sort((a, b) => {
      const x = value(a),
        y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return (sort.desc ? -order : order) || a.name.localeCompare(b.name);
    });
  }, [data, search, sort]);
  const maxWeek = Math.max(1, ...(data?.weekly.map((w) => w.loads) ?? [1]));
  const openLoads = onOpenLoads;
  return (
    <section className="reports" aria-label="Reports">
      <div className="reportBar">
        <div className="segmented" role="group" aria-label="Date range">
          {presets.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={activePreset === n}
              className={"segment" + (activePreset === n ? " active" : "")}
              onClick={() => {
                setCustom(false);
                setFrom(daysAgo(n - 1));
                setTo(iso(new Date()));
                setShown(pageSize);
              }}
            >
              Last {n} days
            </button>
          ))}
          <button
            type="button"
            aria-pressed={custom}
            className={"segment" + (custom ? " active" : "")}
            onClick={() => setCustom(true)}
          >
            Custom
          </button>
        </div>
        {custom && (
          <div className="reportDates">
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
          </div>
        )}
        {carriers.length > 1 && (
          <label className="reportCarrier">
            <span className="srOnly">Carrier</span>
            <select
              value={carrier}
              onChange={(e) => {
                setCarrier(e.target.value);
                setShown(pageSize);
              }}
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
        <a
          className="secondary reportExport"
          href={`/api/reports/loads.csv?${query}`}
          download
        >
          <DownloadSimpleIcon size={15} aria-hidden="true" /> Export loads (CSV)
        </a>
      </div>
      <p className="helpText">
        Loads are counted by first pickup (UTC dates). On-time uses arrivals
        people reported; stops with no report are shown separately.
      </p>
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
      {loading && !data && (
        <div className="reportTiles" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="reportTile skeleton" />
          ))}
        </div>
      )}
      {data && (
        <div aria-busy={loading} className={loading ? "reportStale" : ""}>
          <div className="reportTiles">
            <Tile
              label="Loads"
              value={String(data.loads.loads)}
              hint={`${data.loads.delivered} delivered · ${data.loads.cancelled} cancelled`}
              delta={
                <Delta now={data.loads.loads} before={before?.loads.loads} />
              }
              onOpen={
                openLoads &&
                (() => openLoads({ carrier: carrier || undefined }))
              }
              openLabel="Open loads"
            />
            <Tile
              label="Freight value"
              value={formatMoney(data.loads.freight_minor)}
              hint="Agreed rates, excluding cancelled"
              delta={
                <Delta
                  now={Number(data.loads.freight_minor)}
                  before={before ? Number(before.loads.freight_minor) : null}
                />
              }
            />
            <Tile
              label="Pickups on time"
              value={pct(data.timing.pickup)}
              hint={timingHint(data.timing.pickup)}
              delta={
                <Delta
                  unit="pts"
                  now={data.timing.pickup.on_time_pct}
                  before={before?.timing.pickup.on_time_pct}
                />
              }
            />
            <Tile
              label="Deliveries on time"
              value={pct(data.timing.delivery)}
              hint={timingHint(data.timing.delivery)}
              delta={
                <Delta
                  unit="pts"
                  now={data.timing.delivery.on_time_pct}
                  before={before?.timing.delivery.on_time_pct}
                />
              }
            />
            <Tile
              label="Open exceptions"
              value={String(data.exceptions.open_now)}
              hint={`${data.exceptions.overdue} overdue · ${data.exceptions.opened} opened`}
              onOpen={onOpenExceptions}
              openLabel="Open exceptions"
            />
            <Tile
              label="Delivered, no accepted POD"
              value={String(data.delivered_without_pod)}
              onOpen={
                openLoads &&
                (() =>
                  openLoads({
                    carrier: carrier || undefined,
                    attention: "paperwork",
                  }))
              }
              openLabel="Show these loads"
            />
          </div>

          <h3>Pipeline</h3>
          <div className="pipeline" role="group" aria-label="Pipeline">
            {(
              [
                ["Booked", data.loads.booked, "booked"],
                ["Dispatched", data.loads.dispatched, "dispatched"],
                ["In transit", data.loads.picked_up, "picked-up"],
                ["Delivered", data.loads.delivered, "delivered"],
              ] as const
            ).map(([label, count, status]) => (
              <button
                key={label}
                type="button"
                className="pipelineStep"
                disabled={!openLoads}
                onClick={() =>
                  openLoads?.({ carrier: carrier || undefined, status })
                }
                aria-label={`${label}: ${count}. Open loads`}
              >
                <strong>{count}</strong>
                <small>{label}</small>
              </button>
            ))}
          </div>

          {data.weekly.length > 0 && (
            <>
              <h3>Loads by pickup week</h3>
              <ol className="weekChart" aria-label="Loads by pickup week">
                {data.weekly.map((w) => (
                  <li
                    key={w.week}
                    title={`Week of ${w.week}: ${w.loads} loads, ${formatMoney(w.freight_minor)}`}
                  >
                    <strong>{w.loads}</strong>
                    <span
                      className="column"
                      style={{
                        height: `${Math.max(4, (w.loads / maxWeek) * 100)}%`,
                      }}
                      aria-hidden="true"
                    />
                    <small>
                      <span className="srOnly">Week of </span>
                      {w.week.slice(5)}
                    </small>
                    <span className="srOnly">
                      {w.loads} loads, {formatMoney(w.freight_minor)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          <h3>By carrier</h3>
          {/* Phones show cards without column headers, so sorting is a select. */}
          <label className="reportSort">
            <span className="srOnly">Sort carriers by</span>
            <select
              value={sort.key}
              onChange={(e) => {
                const col = sortColumns.find((c) => c.key === e.target.value)!;
                setSort({ key: col.key, desc: col.numeric });
              }}
            >
              {sortColumns.map((c) => (
                <option key={c.key} value={c.key}>
                  Sort: {c.label}
                </option>
              ))}
            </select>
          </label>
          <div
            className="tableScroll reportCards"
            role="region"
            aria-label="By carrier"
            tabIndex={0}
          >
            <table className="reportTable">
              <thead>
                <tr>
                  {sortColumns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={
                        sort.key === c.key
                          ? sort.desc
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        className="sortButton"
                        onClick={() =>
                          setSort((old) => ({
                            key: c.key,
                            desc: old.key === c.key ? !old.desc : c.numeric,
                          }))
                        }
                      >
                        {c.label}
                        {sort.key === c.key &&
                          (sort.desc ? (
                            <ArrowDownIcon size={11} aria-hidden="true" />
                          ) : (
                            <ArrowUpIcon size={11} aria-hidden="true" />
                          ))}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      {openLoads ? (
                        <button
                          type="button"
                          className="textButton"
                          onClick={() => openLoads({ carrier: c.id })}
                          aria-label={`Open loads for ${c.name}`}
                        >
                          {c.name}
                        </button>
                      ) : (
                        c.name
                      )}
                    </th>
                    <td data-label="Loads">{c.loads}</td>
                    <td data-label="Delivered">{c.delivered}</td>
                    <td data-label="Cancelled">{c.cancelled}</td>
                    <td data-label="Freight">{formatMoney(c.freight_minor)}</td>
                    <td data-label="Open exceptions">{c.open_exceptions}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6}>
                      {data.carriers.length
                        ? "No carrier matches your search."
                        : "No loads in this range. Try a longer range."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > shown && (
            <button
              type="button"
              className="secondary"
              onClick={() => setShown((n) => n + pageSize)}
            >
              Show {Math.min(pageSize, rows.length - shown)} more
            </button>
          )}

          {data.exceptions.by_type.length > 0 && (
            <>
              <h3>Exceptions</h3>
              <div
                className="tableScroll reportCards"
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
                        <th scope="row">
                          {onOpenExceptions ? (
                            <button
                              type="button"
                              className="textButton"
                              onClick={onOpenExceptions}
                            >
                              {typeLabels[x.type] ?? x.type}
                            </button>
                          ) : (
                            (typeLabels[x.type] ?? x.type)
                          )}
                        </th>
                        <td data-label="Opened">{x.opened}</td>
                        <td data-label="Open now">{x.open_now}</td>
                        <td data-label="Overdue">{x.overdue}</td>
                        <td data-label="Avg. hours to resolve">{x.avg_hours}</td>
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
                  onOpen={onOpenBilling}
                  openLabel="Open billing"
                />
                <Tile
                  label="Dispatch fees outstanding"
                  value={formatMoney(data.dispatch_invoices.outstanding_minor)}
                  hint={`${data.dispatch_invoices.overdue} overdue · ${formatMoney(data.dispatch_invoices.paid_minor)} paid`}
                  onOpen={onOpenBilling}
                  openLabel="Open billing"
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
