"use client";
import { useCallback, useEffect, useState } from "react";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { WarningIcon } from "@phosphor-icons/react";
import { ApiError, useApi } from "@/lib/client-api";
import {
  exceptionStatusLabels,
  exceptionTypeLabels,
  type LoadException,
} from "@/lib/exception-rules";
import { severityTone, when } from "./load-exceptions";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorAlert } from "@/components/ui/feedback";

export function ExceptionQueue({
  onOpenLoad,
  onShowLoads,
  query = "",
  onClearQuery,
  onAuthError,
  driverOnly,
  revision,
}: {
  revision: number;
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
  onShowLoads: () => void;
  onOpenLoad: (id: string) => void;
  onAuthError: (e: unknown) => void;
  driverOnly: boolean;
}) {
  const api = useApi();
  const [status, setStatus] = useState("active"),
    [owner, setOwner] = useState("any"),
    [overdue, setOverdue] = useState(false),
    [all, setItems] = useState<LoadException[] | null>(null),
    [truncated, setTruncated] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [now, setNow] = useState(0);
  const needle = query.trim().toLowerCase();
  const items =
    all && needle
      ? all.filter((e) =>
          [
            e.summary,
            (e as { load_reference?: string }).load_reference,
            (e as { carrier_name?: string }).carrier_name,
            e.owner_name,
            e.type,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : all;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{
        exceptions: LoadException[];
        truncated: boolean;
      }>(
        "exceptions?" +
          new URLSearchParams({
            status,
            owner,
            ...(overdue ? { overdue: "true" } : {}),
          }),
      );
      setNow(Date.now());
      setItems(data.exceptions);
      setTruncated(data.truncated);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setLoading(false);
    }
  }, [api, status, owner, overdue, onAuthError]);
  useEffect(() => {
    // Fetch whenever filters change; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // revision is a refresh signal from exception changes made elsewhere.
  }, [load, revision]);
  const overdueNow = (item: LoadException) =>
    item.status !== "resolved" &&
    !!item.due_at &&
    Date.parse(item.due_at) < now;
  const columns: ColumnDefinition<LoadException>[] = [
    {
      id: "summary",
      header: "Exception",
      accessor: "summary",
      width: "xl",
      render: (summary) => (
        <span className="excSummary">
          <WarningIcon size={14} aria-hidden="true" />
          {String(summary)}
        </span>
      ),
    },
    {
      id: "severity",
      header: "Severity",
      accessor: "severity",
      sortable: true,
      sortValue: (x) => ["high", "medium", "low"].indexOf(x.severity),
      render: (severity) => (
        <StatusBadge tone={severityTone(String(severity))}>
          {String(severity)}
        </StatusBadge>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (x) => exceptionStatusLabels[x.status],
      render: (label, x) => (
        <StatusBadge tone={x.status === "resolved" ? "good" : "neutral"}>
          {String(label)}
        </StatusBadge>
      ),
    },
    { id: "load", header: "Load", accessor: "load_reference" },
    {
      id: "carrier",
      header: "Carrier",
      accessor: "carrier_name",
      priority: "low",
    },
    {
      id: "type",
      header: "Type",
      accessor: (x) => exceptionTypeLabels[x.type],
      priority: "low",
    },
    {
      id: "owner",
      header: "Owner",
      accessor: (x) => x.owner_name || "Unassigned",
    },
    {
      id: "due",
      header: "Due",
      accessor: "due_at",
      sortable: true,
      sortValue: (x) =>
        x.due_at ? Date.parse(x.due_at) : Number.MAX_SAFE_INTEGER,
      render: (_, x) =>
        x.due_at ? (
          <span className={overdueNow(x) ? "lateText" : undefined}>
            {when(x.due_at)}
            {overdueNow(x) && " (overdue)"}
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "actions",
      header: "Actions",
      accessor: "id",
      align: "right",
      render: (_, x) => (
        <button
          className="secondary"
          onClick={() => onOpenLoad(x.load_id)}
          aria-label={`Open load ${x.load_reference} for exception ${x.summary}`}
        >
          Open load
        </button>
      ),
    },
  ];
  const tiles: [string, number][] = items
    ? [
        ["Shown", items.length],
        ["High severity", items.filter((i) => i.severity === "high").length],
        ["Overdue", items.filter(overdueNow).length],
        [
          "Unassigned",
          items.filter((i) => !i.owner_name && i.status !== "resolved").length,
        ],
      ]
    : [];
  return (
    <section className="excPage" aria-label="Exception queue">
      <h2 className="srOnly">Exceptions</h2>
      <div className="excBar opsFilters">
        <label>
          <span className="srOnly">Exception status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Open and in progress</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
        {!driverOnly && (
          <label>
            <span className="srOnly">Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="any">Any owner</option>
              <option value="me">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
        )}
        <label className="setupCheckbox">
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => setOverdue(e.target.checked)}
          />
          <span>Overdue only</span>
        </label>
      </div>
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p className="srOnly" role="status">
        {loading
          ? "Loading exceptions"
          : items
            ? `${items.length} exceptions shown`
            : ""}
      </p>
      {loading && !items && !error && (
        <div className="excSkeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      {items && items.length > 0 && (
        <>
          <StatTiles label="Exception summary">
            {tiles.map(([label, n]) => (
              <StatTile key={label} label={label} value={n} />
            ))}
          </StatTiles>
          <DataTable
            caption="Exceptions"
            columns={columns}
            data={items}
            getRowId={(x) => x.id}
            rowClassName={(x) => "sev-" + x.severity}
            defaultSort={{ column: "due", descending: false }}
            empty={{ title: "No exceptions" }}
          />
        </>
      )}
      {items && !items.length && !loading && (
        <EmptyState
          icon={WarningIcon}
          title="No exceptions match"
          description={
            needle
              ? "Try a different load, carrier or word."
              : "Exceptions are raised on a load."
          }
          action={
            needle ? (
              onClearQuery && (
                <button className="secondary" onClick={onClearQuery}>
                  Clear search
                </button>
              )
            ) : (
              <button className="secondary" onClick={onShowLoads}>
                Choose a load
              </button>
            )
          }
        />
      )}
      {truncated && (
        <p className="helpText">
          Showing the 100 most urgent. Narrow the filters to see others.
        </p>
      )}
    </section>
  );
}
