"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { WarningIcon } from "@phosphor-icons/react";
import type { WorkspaceFilters } from "@/lib/routes";
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
  scope = {},
  onScopeChange,
}: {
  revision: number;
  scope?: WorkspaceFilters;
  onScopeChange?: (scope: WorkspaceFilters) => void;
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
  onShowLoads: () => void;
  onOpenLoad: (id: string) => void;
  onAuthError: (e: unknown) => void;
  driverOnly: boolean;
}) {
  const api = useApi();
  const status = scope.status ?? "active",
    owner = scope.owner ?? "any",
    overdue = scope.overdue === "true";
  const setStatus = (status: string) => onScopeChange?.({ ...scope, status });
  const setOwner = (owner: string) => onScopeChange?.({ ...scope, owner });
  const setOverdue = (overdue: boolean) =>
    onScopeChange?.({ ...scope, overdue: String(overdue) });
  const [items, setItems] = useState<LoadException[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [now, setNow] = useState(0);
  const sequence = useRef(0);
  const needle = query.trim().toLowerCase();
  const queryScope = JSON.stringify({
    ...scope,
    status,
    owner,
    overdue: String(overdue),
    ...(query ? { q: query } : {}),
  });
  const load = useCallback(
    async (after?: string) => {
      const request = ++sequence.current;
      setLoading(true);
      setError("");
      try {
        const data = await api<{
          exceptions: LoadException[];
          nextCursor: string | null;
        }>(
          "exceptions?" +
            new URLSearchParams({
              ...JSON.parse(queryScope),
              ...(after ? { cursor: after } : {}),
            }),
        );
        if (request !== sequence.current) return;
        setNow(Date.now());
        setItems((old) =>
          after
            ? [
                ...(old ?? []),
                ...data.exceptions.filter(
                  (x) => !old?.some((y) => y.id === x.id),
                ),
              ]
            : data.exceptions,
        );
        setCursor(data.nextCursor);
      } catch (e) {
        if (request !== sequence.current) return;
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [api, queryScope, onAuthError],
  );
  const invalidate = useCallback(() => {
    sequence.current++;
  }, []);
  useEffect(() => {
    // Fetch whenever filters change; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return invalidate;
    // revision is a refresh signal from exception changes made elsewhere.
  }, [load, revision, invalidate]);
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
      {cursor && (
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          {loading ? "Loading…" : "Load more exceptions"}
        </button>
      )}
      {!!items?.length && (
        <p className="helpText">
          Counts describe {items.length} loaded exceptions
          {cursor ? "; more records are available" : ""}.
        </p>
      )}
    </section>
  );
}
