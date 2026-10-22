"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
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
type Sort = "name" | "active" | "expiry";
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
    [sort, setSort] = useState<Sort>("name"),
    [shown, setShown] = useState(pageSize),
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
    const key = (id: string, name: string) => {
      const s = summary?.get(id);
      if (sort === "active") return -(s?.loads.active ?? 0);
      if (sort === "expiry")
        return s?.authorization.expires_at
          ? Date.parse(s.authorization.expires_at)
          : Infinity;
      return name.toLowerCase();
    };
    return [...list].sort((a, b) => {
      const x = key(a.id, a.name),
        y = key(b.id, b.name);
      return x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name);
    });
  }, [context.carriers, summary, filter, sort, text]);

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
    setShown(pageSize);
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
          <div
            className="carrierStats"
            role="group"
            aria-label="Filter carriers"
          >
            {stats.map((s) => (
              <button
                key={s.id}
                type="button"
                className={"carrierStat" + (filter === s.id ? " active" : "")}
                aria-pressed={filter === s.id}
                disabled={!summary}
                onClick={() => pick(s.id)}
              >
                <strong>{summary ? s.value : "–"}</strong>
                <small>{s.label}</small>
              </button>
            ))}
          </div>
          <div className="carrierToolbar">
            <label className="carrierSort">
              <span className="srOnly">Sort carriers</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
              >
                <option value="name">Sort: Name</option>
                <option value="active">Sort: Active loads</option>
                <option value="expiry">Sort: Agreement expiry</option>
              </select>
            </label>
          </div>
        </>
      )}

      {rows.length ? (
        <div className="directoryTable carrierList">
          {rows.slice(0, shown).map((c) => {
            const s = summary?.get(c.id);
            return (
              <article className="directoryRow" key={c.id}>
                <div className="directoryCarrier">
                  <span className="carrierMark">
                    <BuildingsIcon size={22} aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{c.name}</h3>
                    {(mixedRoles || c.role !== "dispatcher") && (
                      <small className="roleLabel">
                        {roles[c.role] || "Member"}
                      </small>
                    )}
                  </div>
                </div>
                {c.role !== "driver" && (
                  <div className="carrierFacts">
                    {s ? (
                      <>
                        <button
                          type="button"
                          className={
                            "opsPill carrierAuth " +
                            authTone(s.authorization.state)
                          }
                          disabled={busy || !onSetup}
                          onClick={() => onSetup?.(c.id)}
                          aria-label={`${authLabel(s.authorization)}. Open setup for ${c.name}`}
                        >
                          {authLabel(s.authorization)}
                        </button>
                        <button
                          type="button"
                          className="carrierMetric"
                          onClick={() => onViewLoads(c.id)}
                          aria-label={`${s.loads.active} active loads for ${c.name}. Open loads`}
                        >
                          <strong>{s.loads.active}</strong>
                          <small>Active loads</small>
                        </button>
                        <button
                          type="button"
                          className={
                            "carrierMetric" +
                            (s.open_exceptions ? " attention" : "")
                          }
                          disabled={!onOpenExceptions}
                          onClick={onOpenExceptions}
                          aria-label={`${s.open_exceptions} open exceptions for ${c.name}. Open exceptions`}
                        >
                          <strong>{s.open_exceptions}</strong>
                          <small>Open exceptions</small>
                        </button>
                        <span className="carrierMetric">
                          <strong>{s.drivers}</strong>
                          <small>Drivers</small>
                        </span>
                      </>
                    ) : error ? (
                      <small className="helpText">Status unavailable</small>
                    ) : (
                      <span className="skeletonLine" aria-hidden="true" />
                    )}
                  </div>
                )}
                <div className="directoryRowActions">
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
                  <button
                    className="secondary"
                    onClick={() => onViewLoads(c.id)}
                  >
                    View loads
                    <ArrowUpRightIcon size={14} aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="directoryEmpty">
          <BuildingsIcon size={40} weight="light" aria-hidden="true" />
          <h3>
            {context.carriers.length
              ? "No matching carriers"
              : "No carrier access yet"}
          </h3>
          <p>
            {context.carriers.length
              ? "Try a different carrier name or clear the filter."
              : "Ask your workspace administrator to grant carrier access."}
          </p>
          {(text || filter !== "all") && (
            <button
              className="secondary"
              onClick={() => {
                setFilter("all");
                if (text) (onClearQuery ?? (() => setQuery("")))();
              }}
            >
              Clear search
            </button>
          )}
        </div>
      )}
      {rows.length > shown && (
        <button
          type="button"
          className="secondary"
          onClick={() => setShown((n) => n + pageSize)}
        >
          Show {Math.min(pageSize, rows.length - shown)} more
        </button>
      )}
      <p className="directoryNote">
        Workspace access is separate from dispatch authority. A current verified
        dispatch agreement is checked when booking or assigning a load.
      </p>
    </section>
  );
}
