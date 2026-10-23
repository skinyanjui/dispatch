"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import {
  ArrowUpRightIcon,
  BuildingsIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { Context } from "@/lib/contracts";
import type { CarrierSummary } from "@/lib/carrier-summary";

const roles: Record<string, string> = {
  dispatcher: "Dispatcher",
  "carrier-manager": "Carrier manager",
  driver: "Driver · assigned loads only",
};
type Filter =
  | "all"
  | "authorized"
  | "expiring"
  | "not-authorized"
  | "exceptions";
const pageSize = 25;
const day = 86_400_000;
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function authLabel(a: CarrierSummary["authorization"]) {
  if (a.state === "none") return "No dispatch agreement";
  const when = a.expires_at ? date(a.expires_at) : "";
  if (a.state === "expired") return `Agreement expired ${when}`;
  if (a.state === "expiring") {
    const days = Math.max(
      0,
      Math.ceil((Date.parse(a.expires_at!) - Date.now()) / day),
    );
    return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  }
  return `Authorized until ${when}`;
}
const authTone = (s: CarrierSummary["authorization"]["state"]) =>
  s === "current" ? "good" : s === "expiring" ? "warn" : "bad";

export function CarrierDirectory({
  context,
  onViewLoads,
  onSetup,
  onDocuments,
  onOpenExceptions,
  onAdd,
  onAuthError,
  busy = false,
  query,
  onClearQuery,
}: {
  context: Context;
  onViewLoads: (carrier: string) => void;
  onSetup?: (carrier: string) => void;
  onDocuments?: (carrier: string) => void;
  onOpenExceptions?: () => void;
  onAdd?: () => void;
  onAuthError?: (e: unknown) => void;
  busy?: boolean;
  /** Search text from the page header; without it the page has its own box. */
  query?: string;
  /** Clears the page search (the sidebar box) when it is controlled. */
  onClearQuery?: () => void;
}) {
  const api = useApi();
  const [ownQuery, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all"),
    [summary, setSummary] = useState<Map<string, CarrierSummary> | null>(null),
    [error, setError] = useState("");
  const text = (query ?? ownQuery).trim().toLowerCase();
  const manages = context.carriers.some((c) => c.role !== "driver");
  const loadSummary = useCallback(async () => {
    setError("");
    try {
      const result = await api<{ carriers: CarrierSummary[] }>(
        "carriers/summary",
      );
      setSummary(new Map(result.carriers.map((c) => [c.id, c])));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError?.(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    }
  }, [api, onAuthError]);
  useEffect(() => {
    // Fetch once on mount; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (manages) void loadSummary();
  }, [manages, loadSummary]);

  const counts = useMemo(() => {
    const all = [...(summary?.values() ?? [])];
    return {
      authorized: all.filter((c) => c.authorization.state === "current").length,
      expiring: all.filter((c) => c.authorization.state === "expiring").length,
      notAuthorized: all.filter((c) =>
        ["expired", "none"].includes(c.authorization.state),
      ).length,
      exceptions: all.filter((c) => c.open_exceptions > 0).length,
    };
  }, [summary]);

  // The role is only worth showing when it differs from row to row.

  const mixedRoles = new Set(context.carriers.map((c) => c.role)).size > 1;

  const rows = useMemo(() => {
    const matches = (id: string) => {
      const s = summary?.get(id);
      if (filter === "all" || !s) return filter === "all";
      if (filter === "authorized") return s.authorization.state === "current";
      if (filter === "expiring") return s.authorization.state === "expiring";
      if (filter === "not-authorized")
        return ["expired", "none"].includes(s.authorization.state);
      return s.open_exceptions > 0;
    };
    const list = context.carriers.filter(
      (c) => c.name.toLowerCase().includes(text) && matches(c.id),
    );
    return list;
  }, [context.carriers, summary, filter, text]);
  type Row = Context["carriers"][number];
  const stat = (id: string) => summary?.get(id);
  // Figures wait for the summary; a failed summary says so once per cell.
  const pending = (id: string) =>
    stat(id) ? null : error ? "Unavailable" : "…";
  const columns: ColumnDefinition<Row>[] = [
    {
      id: "name",
      header: "Carrier",
      accessor: "name",
      sortable: true,
      render: (_, c) => (
        <span className="carrierName">
          <BuildingsIcon size={16} aria-hidden="true" />
          {c.name}
          {(mixedRoles || c.role !== "dispatcher") && (
            <small className="roleLabel">{roles[c.role] || "Member"}</small>
          )}
        </span>
      ),
    },
    {
      id: "authorization",
      header: "Dispatch authorization",
      accessor: (c) => stat(c.id)?.authorization.expires_at ?? "",
      sortable: true,
      sortValue: (c) => {
        const at = stat(c.id)?.authorization.expires_at;
        return at ? Date.parse(at) : Number.MAX_SAFE_INTEGER;
      },
      render: (_, c) => {
        const s = stat(c.id);
        if (c.role === "driver") return "—";
        if (!s) return pending(c.id);
        return (
          <button
            type="button"
            className={"opsPill carrierAuth " + authTone(s.authorization.state)}
            disabled={busy || !onSetup}
            onClick={() => onSetup?.(c.id)}
            aria-label={`${authLabel(s.authorization)}. Open setup for ${c.name}`}
          >
            {authLabel(s.authorization)}
          </button>
        );
      },
    },
    {
      id: "active",
      header: "Active loads",
      accessor: (c) => stat(c.id)?.loads.active,
      type: "number",
      sortable: true,
      descendingFirst: true,
      render: (value, c) =>
        c.role === "driver" ? (
          "—"
        ) : value === undefined ? (
          pending(c.id)
        ) : (
          <button
            type="button"
            className="textButton"
            onClick={() => onViewLoads(c.id)}
            aria-label={`${value} active loads for ${c.name}. Open loads`}
          >
            {String(value)}
          </button>
        ),
    },
    {
      id: "exceptions",
      header: "Open exceptions",
      accessor: (c) => stat(c.id)?.open_exceptions,
      type: "number",
      sortable: true,
      descendingFirst: true,
      render: (value, c) =>
        c.role === "driver" ? (
          "—"
        ) : value === undefined ? (
          pending(c.id)
        ) : (
          <button
            type="button"
            className={"textButton" + (Number(value) ? " lateText" : "")}
            disabled={!onOpenExceptions}
            onClick={onOpenExceptions}
            aria-label={`${value} open exceptions for ${c.name}. Open exceptions`}
          >
            {String(value)}
          </button>
        ),
    },
    {
      id: "drivers",
      header: "Drivers",
      accessor: (c) => stat(c.id)?.drivers,
      type: "number",
      priority: "low",
      render: (value, c) =>
        c.role === "driver"
          ? "—"
          : value === undefined
            ? pending(c.id)
            : String(value),
    },
    {
      id: "actions",
      header: "Actions",
      accessor: "id",
      align: "right",
      render: (_, c) => (
        <div className="rowActions">
          {c.role !== "driver" && onSetup && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => onSetup(c.id)}
            >
              Manage setup
            </button>
          )}
          {c.role !== "driver" && onDocuments && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => onDocuments(c.id)}
              aria-label={`Documents for ${c.name}`}
            >
              Documents
            </button>
          )}
          <button className="secondary" onClick={() => onViewLoads(c.id)}>
            View loads
            <ArrowUpRightIcon size={14} aria-hidden="true" />
          </button>
        </div>
      ),
    },
  ];

  const stats: { id: Filter; label: string; value: number }[] = [
    { id: "authorized", label: "Authorized", value: counts.authorized },
    { id: "expiring", label: "Expiring in 30 days", value: counts.expiring },
    {
      id: "not-authorized",
      label: "Not authorized",
      value: counts.notAuthorized,
    },
    {
      id: "exceptions",
      label: "With open exceptions",
      value: counts.exceptions,
    },
  ];
  const pick = (f: Filter) => {
    setFilter((old) => (old === f ? "all" : f));
  };

  return (
    <section
      className="carrierDirectory"
      aria-label="Authorized carrier directory"
    >
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Carrier accounts</h2>
          <p>Dispatch authorization, activity and access for each carrier.</p>
        </div>
        <div className="directoryControls">
          {(context.organizations?.length ?? 0) > 0 && onAdd && (
            <button className="primary" disabled={busy} onClick={onAdd}>
              Add carrier
            </button>
          )}
          <label className="directorySearch" hidden={query !== undefined}>
            <MagnifyingGlassIcon size={18} aria-hidden="true" />
            <span className="srOnly">Search carriers</span>
            <input
              value={ownQuery}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search carriers…"
            />
          </label>
        </div>
      </div>

      {manages && (
        <>
          {error && (
            <div className="alert error" role="alert">
              {describe(error)}
              <button
                type="button"
                className="secondary"
                onClick={() => void loadSummary()}
              >
                Retry
              </button>
            </div>
          )}
          <StatTiles label="Filter carriers">
            {stats.map((s) => (
              <StatTile
                key={s.id}
                label={s.label}
                value={summary ? s.value : "–"}
                pressed={filter === s.id}
                disabled={!summary}
                onSelect={() => pick(s.id)}
              />
            ))}
          </StatTiles>
        </>
      )}

      <DataTable
        caption="Carriers"
        className="carrierTable"
        columns={columns}
        data={rows}
        getRowId={(c) => c.id}
        defaultSort={{ column: "name", descending: false }}
        pageSize={pageSize}
        pageKey={filter + "|" + text}
        empty={{
          title: context.carriers.length
            ? "No matching carriers"
            : "No carrier access yet",
          description: context.carriers.length
            ? "Try a different carrier name or clear the filter."
            : "Ask your workspace administrator to grant carrier access.",
          action:
            text || filter !== "all" ? (
              <button
                className="secondary"
                onClick={() => {
                  setFilter("all");
                  if (text) (onClearQuery ?? (() => setQuery("")))();
                }}
              >
                Clear search
              </button>
            ) : undefined,
        }}
      />
      <p className="directoryNote">
        Workspace access is separate from dispatch authority. A current verified
        dispatch agreement is checked when booking or assigning a load.
      </p>
    </section>
  );
}
