"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { ApiError, describe, useApi } from "@/lib/client-api";

type Entry = {
  id: string;
  at: string;
  actor: { id: string; name: string } | null;
  action: string;
  label: string;
  resource_id: string | null;
};
type Job = {
  scope: "tick" | "daily";
  state: "ok" | "failing" | "stale" | "never";
  last_run_at: string | null;
  last_success_at: string | null;
  last_duration_ms: number | null;
};
type Filters = {
  actions: { action: string; label: string }[];
  actors: { id: string; name: string }[];
};

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const jobCopy = {
  tick: {
    name: "Every 15 minutes",
    what: "Appointment reminders, including two hours ahead, and queued messages",
    never:
      "Not set up. Until it is, two-hour reminders go out with the daily run. Whoever runs your Relay deployment can set it up (ADR 0046).",
  },
  daily: {
    name: "Daily sweep",
    what: "Missing proof of delivery, expiring insurance, overdue exceptions and cleanup",
    never: "Has not run yet.",
  },
} as const;
const stateCopy: Record<Job["state"], [string, string]> = {
  ok: ["Running", "good"],
  failing: ["Last run failed", "bad"],
  stale: ["Late", "warn"],
  never: ["Not set up", ""],
};

/** Who did what, and when, for organization owners and admins (ADR 0047), with
 *  the state of the scheduled job beside it. Read-only. */
/** Newest first, as the server returns them; the person is the row's name. */
const auditColumns: ColumnDefinition<Entry>[] = [
  {
    id: "when",
    header: "When",
    accessor: "at",
    render: (_, e) => <time dateTime={e.at}>{stamp(e.at)}</time>,
  },
  {
    id: "who",
    header: "Who",
    accessor: (e) => e.actor?.name ?? "The system",
    rowHeader: true,
  },
  { id: "what", header: "What", accessor: "label", width: "xl" },
  {
    id: "record",
    header: "Record",
    accessor: "resource_id",
    priority: "low",
    render: (id) =>
      id ? (
        <code className="auditRecord" title={String(id)}>
          {String(id)}
        </code>
      ) : (
        "—"
      ),
  },
];

export function AuditLog({
  query = "",
  onClearQuery,
  onAuthError,
}: {
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [action, setAction] = useState(""),
    [actor, setActor] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [entries, setEntries] = useState<Entry[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [filters, setFilters] = useState<Filters>({ actions: [], actors: [] }),
    [jobs, setJobs] = useState<Job[] | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false);
  const request = useRef(0);
  const search = query.trim();
  const params = useCallback(
    (after?: string) =>
      new URLSearchParams({
        ...(action ? { action } : {}),
        ...(actor ? { actor } : {}),
        ...(search ? { q: search } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(after ? { cursor: after } : {}),
      }),
    [action, actor, search, from, to],
  );
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    },
    [onAuthError],
  );
  const load = useCallback(
    async (after?: string) => {
      const mine = ++request.current;
      setError("");
      if (after) setMore(true);
      else setLoading(true);
      try {
        const data = await api<{
          entries: Entry[];
          next_cursor: string | null;
        }>("audit?" + params(after));
        if (mine !== request.current) return;
        setEntries((old) =>
          after && old ? [...old, ...data.entries] : data.entries,
        );
        setCursor(data.next_cursor);
      } catch (e) {
        if (mine === request.current) fail(e);
      } finally {
        if (mine === request.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [api, params, fail],
  );
  useEffect(() => {
    // Refetch when a filter or the page search changes (typing is debounced).
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);
  useEffect(() => {
    // The filter menus and scheduler state load once; the log is the page.
    api<Filters>("audit/filters").then(setFilters).catch(fail);
    api<{ jobs: Job[] }>("jobs/status")
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, [api, fail]);
  const filtered = !!(action || actor || search || from || to);
  const clear = () => {
    setAction("");
    setActor("");
    setFrom("");
    setTo("");
    onClearQuery?.();
  };
  return (
    <section className="carrierDirectory auditPage" aria-label="Audit log">
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Audit log</h2>
          <p>
            Who did what, and when, across your organization. Entries cannot be
            edited or removed. Times are shown in your time zone.
          </p>
        </div>
      </div>
      {jobs && jobs.length > 0 && (
        <div className="auditScheduler" role="group" aria-label="Scheduler">
          {jobs.map((j) => {
            const [label, tone] = stateCopy[j.state];
            const copy = jobCopy[j.scope];
            return (
              <article key={j.scope} className="opsCard">
                <div className="opsCardHeading">
                  <h3>{copy.name}</h3>
                  <span className={"opsPill " + tone}>{label}</span>
                </div>
                <p className="helpText">
                  {j.state === "never"
                    ? copy.never
                    : `Last run ${j.last_run_at ? stamp(j.last_run_at) : "—"}${
                        j.last_duration_ms !== null
                          ? ` · took ${(j.last_duration_ms / 1000).toFixed(1)} s`
                          : ""
                      }${
                        j.state === "failing" && j.last_success_at
                          ? ` · last success ${stamp(j.last_success_at)}`
                          : ""
                      }`}
                </p>
                <p className="helpText">{copy.what}.</p>
              </article>
            );
          })}
        </div>
      )}
      <div
        className="directoryControls opsFilters"
        role="group"
        aria-label="Filter the audit log"
      >
        <label>
          <span className="srOnly">Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {[...filters.actions]
              .sort((x, y) => x.label.localeCompare(y.label))
              .map((a) => (
                <option key={a.action} value={a.action}>
                  {a.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span className="srOnly">Person</span>
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Everyone</option>
            {filters.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="auditDate">
          <span>From</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="auditDate">
          <span>To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {filtered && (
          <button type="button" className="secondary" onClick={clear}>
            Clear filters
          </button>
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
        {loading
          ? "Loading the audit log"
          : entries
            ? `${entries.length} entries shown${cursor ? ", more available" : ""}`
            : ""}
      </p>
      {entries && (
        <DataTable
          caption="Audit log, newest first"
          columns={auditColumns}
          data={entries}
          getRowId={(e) => e.id}
          loading={loading}
          empty={{
            title: filtered ? "No entries match" : "Nothing recorded yet",
            description: filtered
              ? "Try another action, person or date range."
              : "Entries appear here as people use Relay.",
            action: filtered ? (
              <button className="secondary" onClick={clear}>
                Clear filters
              </button>
            ) : undefined,
          }}
        />
      )}
      {cursor && (
        <div className="directoryMore">
          <button
            className="secondary"
            disabled={more}
            onClick={() => void load(cursor)}
          >
            {more ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </section>
  );
}
