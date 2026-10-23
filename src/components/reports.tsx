"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { BarList } from "@/components/ui/bar-list";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import {
  StatTile,
  StatTiles,
  StatTilesLoading,
} from "@/components/ui/stat-tile";
import { ApiError, useApi } from "@/lib/client-api";
import { formatMoney } from "@/lib/entry";
import type { AttentionKey } from "@/lib/attention";
import { ErrorAlert } from "@/components/ui/feedback";
import { ReportExports } from "./report-exports";
import type { WorkspaceFilters } from "@/lib/routes";
import { formatDateTimeLong } from "@/lib/format";

type Timing = {
  measured: number;
  on_time: number;
  not_reported: number;
  on_time_pct: number | null;
};
type Report = {
  range: { from: string; to: string; carrier_id?: string | null };
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
  from?: string;
  to?: string;
  missing_pod?: boolean;
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

const pct = (t: Timing) => (t.on_time_pct === null ? "—" : `${t.on_time_pct}%`);
const timingHint = (t: Timing) =>
  `${t.on_time} of ${t.measured} reported on time` +
  (t.not_reported ? ` · ${t.not_reported} not reported` : "");

type CarrierRow = Report["carriers"][number];
type ExceptionRow = Report["exceptions"]["by_type"][number];

/** The by-carrier table; the carrier cell opens that carrier's loads. */
const carrierColumns = (
  openLoads?: (scope: OpenLoads) => void,
): ColumnDefinition<CarrierRow>[] => [
  {
    id: "name",
    header: "Carrier",
    accessor: "name",
    sortable: true,
    render: (_, c) =>
      openLoads ? (
        <button
          type="button"
          className="textButton rowOpen"
          onClick={() => openLoads({ carrier: c.id })}
          aria-label={`Open loads for ${c.name}`}
        >
          {c.name}
        </button>
      ) : (
        c.name
      ),
  },
  {
    id: "loads",
    header: "Loads",
    accessor: "loads",
    type: "number",
    sortable: true,
    descendingFirst: true,
  },
  {
    id: "delivered",
    header: "Delivered",
    accessor: "delivered",
    type: "number",
    sortable: true,
    descendingFirst: true,
  },
  {
    id: "cancelled",
    header: "Cancelled",
    accessor: "cancelled",
    type: "number",
    sortable: true,
    descendingFirst: true,
    priority: "low",
  },
  {
    id: "freight",
    header: "Freight",
    accessor: "freight_minor",
    type: "money",
    sortable: true,
    descendingFirst: true,
  },
  {
    id: "open",
    header: "Open exceptions",
    accessor: "open_exceptions",
    type: "number",
    sortable: true,
    descendingFirst: true,
  },
];

const exceptionColumns = (
  onOpenExceptions?: (type?: string) => void,
): ColumnDefinition<ExceptionRow>[] => [
  {
    id: "type",
    header: "Type",
    accessor: (x) => typeLabels[x.type] ?? x.type,
    render: (label, x) =>
      onOpenExceptions ? (
        <button
          type="button"
          className="textButton rowOpen"
          onClick={() => onOpenExceptions(x.type)}
        >
          {String(label)}
        </button>
      ) : (
        String(label)
      ),
  },
  { id: "opened", header: "Opened", accessor: "opened", type: "number" },
  { id: "open_now", header: "Open now", accessor: "open_now", type: "number" },
  { id: "overdue", header: "Overdue", accessor: "overdue", type: "number" },
  {
    id: "avg",
    header: "Avg. hours to resolve",
    accessor: "avg_hours",
    type: "number",
  },
];

export function Reports({
  carriers,
  onAuthError,
  onOpenLoads,
  onOpenExceptions,
  onOpenBilling,
  query: search = "",
  scope = {},
  onScopeChange,
  demo = false,
}: {
  carriers: { id: string; name: string }[];
  onAuthError: (e: unknown) => void;
  /** Jump to the Loads board with this scope. */
  onOpenLoads?: (scope: OpenLoads) => void;
  onOpenExceptions?: (scope: WorkspaceFilters) => void;
  demo?: boolean;
  scope?: WorkspaceFilters;
  onScopeChange?: (scope: WorkspaceFilters) => void;
  onOpenBilling?: (scope: WorkspaceFilters) => void;
  /** Search text from the sidebar; filters the by-carrier table. */
  query?: string;
}) {
  const api = useApi();
  const from = scope.from ?? daysAgo(29),
    to = scope.to ?? iso(new Date()),
    carrier = scope.carrier_id ?? "";
  const setFrom = (from: string) => onScopeChange?.({ ...scope, from });
  const setTo = (to: string) => onScopeChange?.({ ...scope, to });
  const setCarrier = (carrier_id: string) =>
    onScopeChange?.({ ...scope, carrier_id });
  const [custom, setCustom] = useState(Boolean(scope.from)),
    [data, setData] = useState<Report | null>(null),
    [before, setBefore] = useState<Report | null>(null),
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
  const invalidate = useCallback(() => {
    request.current++;
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => {
      clearTimeout(timer);
      invalidate();
    };
  }, [load, invalidate]);
  const activePreset = custom
    ? null
    : presets.find((n) => from === daysAgo(n - 1) && to === iso(new Date()));
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.carriers ?? []).filter((c) =>
      c.name.toLowerCase().includes(needle),
    );
  }, [data, search]);
  const stale =
    !!data &&
    (loading ||
      !!error ||
      data.range.from !== from ||
      data.range.to !== to ||
      (data.range.carrier_id ?? "") !== carrier);
  const successful = {
    from: data?.range.from ?? from,
    to: data?.range.to ?? to,
    ...(data?.range.carrier_id ? { carrier: data.range.carrier_id } : {}),
  };
  const openLoads = onOpenLoads
    ? (scope: OpenLoads) => onOpenLoads({ ...scope, ...successful })
    : undefined;
  const openExceptions = onOpenExceptions
    ? (type?: string) =>
        onOpenExceptions({
          from: successful.from,
          to: successful.to,
          ...(successful.carrier ? { carrier_id: successful.carrier } : {}),
          ...(type ? { type } : {}),
          status: "active",
        })
    : undefined;
  return (
    <section className="reports" aria-label="Reports">
      <div className="reportBar">
        <ToggleGroup
          label="Date range"
          variant="segmented"
          items={[
            ...presets.map((n) => ({ id: String(n), label: `Last ${n} days` })),
            { id: "custom", label: "Custom" },
          ]}
          value={custom ? "custom" : activePreset ? String(activePreset) : null}
          onChange={(id) => {
            if (!id) return;
            if (id === "custom") return setCustom(true);
            setCustom(false);
            onScopeChange?.({
              ...scope,
              from: daysAgo(Number(id) - 1),
              to: iso(new Date()),
            });
          }}
        />
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
        {!stale && !loading && !error && data && (
          <a
            className="secondary reportExport"
            href={demo ? "#demo-export" : `/api/reports/loads.csv?${query}`}
            onClick={
              demo
                ? async (e) => {
                    e.preventDefault();
                    const file = await api<{ csv: string; filename: string }>(
                      "reports/loads.csv?" + query,
                    );
                    const url = URL.createObjectURL(
                      new Blob([file.csv], { type: "text/csv" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = file.filename;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 0);
                  }
                : undefined
            }
            download
          >
            <DownloadSimpleIcon size={15} aria-hidden="true" /> Export loads
            (CSV)
          </a>
        )}
      </div>
      {!demo && (
        <ReportExports
          scope={scope}
          from={from}
          to={to}
          carrier={carrier}
          disabled={stale || loading || !!error || !data}
          onScopeChange={onScopeChange}
          onAuthError={onAuthError}
        />
      )}
      <p className="helpText">
        Loads are counted by first pickup (UTC dates). On-time uses arrivals
        people reported; stops with no report are shown separately.
      </p>
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p className="srOnly" role="status">
        {loading
          ? "Loading report"
          : error
            ? "Report refresh failed"
            : "Report loaded"}
      </p>
      {loading && !data && <StatTilesLoading count={6} />}
      {data && (
        <div
          aria-busy={loading}
          className={"reportBody" + (stale ? " reportStale" : "")}
        >
          {stale && (
            <p className="inlineNotice" role="status">
              Previous results — {data.range.from} to {data.range.to} UTC ·{" "}
              {data.range.carrier_id
                ? (carriers.find((c) => c.id === data.range.carrier_id)?.name ??
                  "Selected carrier")
                : "All authorized carriers"}
              .{" "}
              {loading
                ? "Refreshing…"
                : "Refresh failed; these results are not current. Retry above."}
            </p>
          )}
          <StatTiles>
            <StatTile
              label="Loads"
              value={String(data.loads.loads)}
              hint={`${data.loads.delivered} delivered · ${data.loads.cancelled} cancelled`}
              extra={
                <Delta now={data.loads.loads} before={before?.loads.loads} />
              }
              onSelect={
                openLoads &&
                (() => openLoads({ carrier: carrier || undefined }))
              }
              actionLabel="Open loads"
            />
            <StatTile
              label="Freight value"
              value={formatMoney(data.loads.freight_minor)}
              hint="Agreed rates, excluding cancelled"
              extra={
                <Delta
                  now={Number(data.loads.freight_minor)}
                  before={before ? Number(before.loads.freight_minor) : null}
                />
              }
            />
            <StatTile
              label="Pickups on time"
              value={pct(data.timing.pickup)}
              hint={timingHint(data.timing.pickup)}
              extra={
                <Delta
                  unit="pts"
                  now={data.timing.pickup.on_time_pct}
                  before={before?.timing.pickup.on_time_pct}
                />
              }
            />
            <StatTile
              label="Deliveries on time"
              value={pct(data.timing.delivery)}
              hint={timingHint(data.timing.delivery)}
              extra={
                <Delta
                  unit="pts"
                  now={data.timing.delivery.on_time_pct}
                  before={before?.timing.delivery.on_time_pct}
                />
              }
            />
            <StatTile
              label="Open exceptions"
              value={String(data.exceptions.open_now)}
              hint={`${data.exceptions.overdue} overdue · ${data.exceptions.opened} opened`}
              onSelect={openExceptions ? () => openExceptions() : undefined}
              actionLabel="Open exceptions"
            />
            <StatTile
              label="POD not accepted"
              hint="On delivered loads"
              value={String(data.delivered_without_pod)}
              onSelect={
                openLoads &&
                (() =>
                  openLoads({
                    carrier: carrier || undefined,
                    missing_pod: true,
                    status: "delivered",
                  }))
              }
              actionLabel="Show these loads"
            />
          </StatTiles>

          <h3>Pipeline</h3>
          <StatTiles label="Pipeline">
            {(
              [
                ["Booked", data.loads.booked, "booked"],
                ["Dispatched", data.loads.dispatched, "dispatched"],
                ["In transit", data.loads.picked_up, "picked-up"],
                ["Delivered", data.loads.delivered, "delivered"],
              ] as const
            ).map(([label, count, status]) => (
              <StatTile
                key={label}
                label={label}
                value={String(count)}
                actionLabel="Open loads"
                disabled={!openLoads}
                onSelect={() =>
                  openLoads?.({ carrier: carrier || undefined, status })
                }
              />
            ))}
          </StatTiles>

          {data.weekly.length > 0 && (
            <>
              <h3>Loads by pickup week</h3>
              <BarList
                label="Loads by pickup week"
                bars={data.weekly.map((w) => ({
                  key: w.week,
                  label: w.week.slice(5),
                  value: w.loads,
                  display: `${w.loads} · ${formatMoney(w.freight_minor)}`,
                  description: `Week of ${w.week}: ${w.loads} loads, ${formatMoney(w.freight_minor)}`,
                }))}
              />
            </>
          )}

          <h3>By carrier</h3>
          <DataTable
            caption="By carrier"
            columns={carrierColumns(openLoads)}
            data={rows}
            getRowId={(c) => c.id}
            defaultSort={{ column: "loads", descending: true }}
            pageSize={pageSize}
            pageKey={[search, from, to, carrier].join("|")}
            empty={{
              title: data.carriers.length
                ? "No carrier matches your search."
                : "No loads in this range.",
              description: data.carriers.length
                ? undefined
                : "Try a longer range.",
            }}
          />

          {data.exceptions.by_type.length > 0 && (
            <>
              <h3>Exceptions</h3>
              <DataTable
                caption="Exceptions"
                columns={exceptionColumns(openExceptions)}
                data={data.exceptions.by_type}
                getRowId={(x) => x.type}
                empty={{ title: "No exceptions in this range." }}
              />
            </>
          )}

          <h3>Billing</h3>
          <StatTiles>
            {data.dispatch_invoices && (
              <>
                <StatTile
                  label="Dispatch invoices issued"
                  value={formatMoney(data.dispatch_invoices.issued_minor)}
                  hint={`${data.dispatch_invoices.issued} invoices in range`}
                  onSelect={
                    onOpenBilling
                      ? () =>
                          onOpenBilling({
                            from: successful.from,
                            to: successful.to,
                            basis: "issued",
                            ...(successful.carrier
                              ? { carrier_id: successful.carrier }
                              : {}),
                          })
                      : undefined
                  }
                  actionLabel="Open billing"
                />
                <StatTile
                  label="Dispatch fees outstanding"
                  value={formatMoney(data.dispatch_invoices.outstanding_minor)}
                  hint={`${data.dispatch_invoices.overdue} overdue · ${formatMoney(data.dispatch_invoices.paid_minor)} paid to date on invoices issued in range`}
                  onSelect={
                    onOpenBilling
                      ? () =>
                          onOpenBilling({
                            from: successful.from,
                            to: successful.to,
                            basis: "issued",
                            balance: "outstanding",
                            ...(successful.carrier
                              ? { carrier_id: successful.carrier }
                              : {}),
                          })
                      : undefined
                  }
                  actionLabel="Open billing"
                />
              </>
            )}
            <StatTile
              label="Carrier freight billed"
              value={formatMoney(data.carrier_freight_billing.billed_minor)}
              hint={`${data.carrier_freight_billing.submitted} packets submitted`}
            />
            <StatTile
              label="Carrier freight outstanding"
              value={formatMoney(
                data.carrier_freight_billing.outstanding_minor,
              )}
              hint="Current unpaid balances on pickup-cohort packets; Relay holds no freight funds"
            />
          </StatTiles>
          <p className="helpText">
            Generated {formatDateTimeLong(data.generated_at)} from live records.
          </p>
        </div>
      )}
    </section>
  );
}
