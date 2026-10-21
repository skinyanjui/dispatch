"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import {
  SquaresFourIcon,
  ListIcon,
  PlusCircleIcon,
  MagnifyingGlassIcon,
  FunnelSimpleIcon,
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ArrowDownIcon,
  BuildingsIcon,
  TruckIcon,
  XIcon,
  CircleIcon,
  CheckIcon,
  ArrowUpRightIcon,
  ClockIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Modal } from "@/components/modal";
import {
  WorkspaceShell,
  Brand,
  queueTitle,
  type WorkspaceSection,
} from "@/components/workspace-shell";
import { CarrierDirectory } from "@/components/carrier-directory";
import {
  stages,
  stageLabels,
  type Load,
  type Context,
  type Queue,
} from "@/lib/contracts";
import { dollarsToMinor, appointmentToInstant, formatMoney } from "@/lib/entry";

const messages: Record<string, string> = {
  VERSION_CONFLICT:
    "Someone updated this load. Refresh its details to review the latest version before retrying.",
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  SERVICE_UNAVAILABLE: "The workspace is unavailable. Please retry.",
  CARRIER_AUTHORIZATION_REQUIRED:
    "This carrier needs a verified, current dispatch agreement before booking or assignment.",
  DUPLICATE_REFERENCE: "This carrier already has a load with that reference.",
  ASSIGN_DRIVER_FIRST: "Assign an authorized driver before dispatching.",
  VALIDATION_ERROR:
    "Check your entries. Pickup must precede delivery, and both appointments need a valid time zone.",
  TRY_AGAIN_LATER: "Too many sign-in attempts. Please try again in one minute.",
  NOT_FOUND: "This load is unavailable or outside your access.",
  AUTH_REQUIRED: "Please sign in to continue.",
  SESSION_EXPIRED: "Your session expired. Sign in again to continue.",
  INVALID_CURSOR: "This queue has changed. Refresh the view.",
  DRIVER_CARRIER_MISMATCH: "Choose a driver authorized by this carrier.",
};
class ApiError extends Error {
  constructor(
    public status: number,
    code: string,
  ) {
    super(code);
  }
}
async function api<T>(
  path: string,
  body?: unknown,
  key?: string,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/" + path, {
      method: body ? "POST" : "GET",
      headers: body
        ? {
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          }
        : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new ApiError(503, "SERVICE_UNAVAILABLE");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status === 401 ? 401 : 503,
      response.status === 401 ? "SESSION_EXPIRED" : "SERVICE_UNAVAILABLE",
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof data?.error === "string" ? data.error : "SERVICE_UNAVAILABLE",
    );
  return data as T;
}
function describe(error: string) {
  return messages[error] || error;
}
const eventLabels: Record<string, string> = {
  "load.created": "Load created",
  "load.assign": "Driver assigned",
  "load.milestones": "Milestone recorded",
};

export default function Workspace() {
  const [context, setContext] = useState<Context | null>(null),
    [ready, setReady] = useState(false),
    [loads, setLoads] = useState<Load[]>([]),
    [selected, setSelected] = useState<Load | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [q, setQ] = useState(""),
    [carrier, setCarrier] = useState(""),
    [status, setStatus] = useState(""),
    [creating, setCreating] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [offline, setOffline] = useState(false),
    [view, setView] = useState<"board" | "list">("board"),
    [filters, setFilters] = useState(false),
    [updated, setUpdated] = useState<Date | null>(null),
    [section, setSection] = useState<WorkspaceSection>("loads");
  const search = useRef<HTMLInputElement>(null),
    createRequest = useRef<{ payload: string; key: string } | null>(null),
    revision = useRef(0),
    active = useRef(false),
    queueRequest = useRef(0);
  const query = useCallback(
    () =>
      new URLSearchParams({
        ...(q ? { q } : {}),
        ...(carrier ? { carrier_id: carrier } : {}),
        ...(status ? { status } : {}),
      }),
    [q, carrier, status],
  );
  const handleError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      active.current = false;
      setContext(null);
      setSelected(null);
      setCreating(false);
      setLoads([]);
      setQ("");
      setCarrier("");
      setStatus("");
      setCursor(null);
      setNotice("");
      setUpdated(null);
      queueRequest.current++;
      setSection("loads");
    }
    setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
  }, []);
  const refresh = useCallback(async () => {
    const version = revision.current,
      request = ++queueRequest.current;
    setLoading(true);
    try {
      const data = await api<Queue>("loads?" + query());
      if (
        request !== queueRequest.current ||
        version !== revision.current ||
        !active.current
      )
        return;
      setLoads(data.loads);
      setCursor(data.nextCursor);
      setUpdated(new Date());
    } catch (e) {
      if (request === queueRequest.current && version === revision.current)
        throw e;
    } finally {
      if (request === queueRequest.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    api<Context>("me")
      .then((c) => {
        active.current = true;
        setContext(c);
      })
      .catch((e) => {
        if (e.message !== "AUTH_REQUIRED" && e.message !== "SESSION_EXPIRED")
          handleError(e);
      })
      .finally(() => setReady(true));
    const connection = () => setOffline(!navigator.onLine);
    const keyboard = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (!search.current || document.querySelector("dialog[open]")) return;
        e.preventDefault();
        search.current.focus();
      }
    };
    const timer = setTimeout(connection, 0);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    window.addEventListener("keydown", keyboard);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      window.removeEventListener("keydown", keyboard);
    };
  }, [handleError]);
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    const request = ++queueRequest.current;
    const timer = setTimeout(async () => {
      if (request !== queueRequest.current) return;
      setLoading(true);
      setError("");
      try {
        const data = await api<Queue>(
          "loads?" + query(),
          undefined,
          undefined,
          controller.signal,
        );
        if (
          !controller.signal.aborted &&
          request === queueRequest.current &&
          active.current
        ) {
          setLoads(data.loads);
          setCursor(data.nextCursor);
          setUpdated(new Date());
        }
      } catch (e) {
        if (!controller.signal.aborted && request === queueRequest.current)
          handleError(e);
      } finally {
        if (!controller.signal.aborted && request === queueRequest.current)
          setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [context, query, handleError]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  function filterChange(
    patch: Partial<{ q: string; carrier: string; status: string }>,
  ) {
    const next = { q, carrier, status, ...patch };
    if (next.q === q && next.carrier === carrier && next.status === status)
      return;
    revision.current++;
    queueRequest.current++;
    setLoading(true);
    setQ(next.q);
    setCarrier(next.carrier);
    setStatus(next.status);
  }
  function createLoad() {
    if (busy || offline || selected || creating) return;
    createRequest.current = null;
    setError("");
    setCreating(true);
  }
  function focusSearch() {
    setSection("loads");
    requestAnimationFrame(() => search.current?.focus());
  }
  function showQueue(value: string) {
    setSection("loads");
    filterChange({ status: value });
  }
  function showCarrier(value: string) {
    setSection("loads");
    filterChange({ carrier: value });
  }
  async function refreshAfterSave(message: string) {
    setNotice(message);
    try {
      await refresh();
    } catch (e) {
      handleError(e);
    }
  }

  async function open(id: string) {
    await act(async () => setSelected(await api<Load>("loads/" + id)));
  }
  async function logout() {
    await act(async () => {
      await api("logout", {});
      active.current = false;
      revision.current++;
      queueRequest.current++;
      setSection("loads");
      setContext(null);
      setLoads([]);
      setSelected(null);
      setCreating(false);
      setQ("");
      setCarrier("");
      setStatus("");
      setCursor(null);
      setUpdated(null);
    });
  }
  const errorPanel = error ? (
    <div className="alert error" role="alert">
      <WarningCircleIcon size={18} aria-hidden="true" />
      <span>{describe(error)}</span>
      {context && !selected && !creating && (
        <button
          className="textButton"
          disabled={busy}
          onClick={() => act(refresh)}
        >
          Retry
        </button>
      )}
    </div>
  ) : null;
  if (!ready)
    return (
      <main className="loading" role="status">
        Opening your workspace…
      </main>
    );
  if (!context)
    return (
      <main className="login">
        <Brand />
        <section className="loginPanel">
          <p className="eyebrow">DISPATCH, WITH CLARITY</p>
          <h1>
            Everything in motion.
            <br />
            All in one place.
          </h1>
          <p className="loginDescription">
            Sign in to your dispatch workspace.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              act(async () => {
                await api("login", {
                  email: f.get("email"),
                  password: f.get("password"),
                });
                const c = await api<Context>("me");
                active.current = true;
                setContext(c);
              });
            }}
          >
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
              />
            </label>
            <button className="primary full" disabled={busy || offline}>
              {busy ? "Signing in…" : "Sign in"}
              <ArrowRightIcon size={16} aria-hidden="true" />
            </button>
          </form>
          {errorPanel}
          <p className="loginFoot">
            Fictional QA data. No live freight connections.
            <br />
            <a href="/demo.html">
              Explore original demo{" "}
              <ArrowUpRightIcon size={12} aria-hidden="true" />
            </a>
          </p>
        </section>
        <span className="loginBottom">
          A little less busywork. A lot more visibility.
        </span>
      </main>
    );
  const canWrite = context.carriers.some((c) => c.role !== "driver");
  const selectedRole = context.carriers.find(
    (c) => c.id === selected?.carrier_id,
  )?.role;
  const selectedCarrier = context.carriers.find(
    (c) => c.id === selected?.carrier_id,
  )?.name;
  const filterCount = Number(Boolean(carrier)) + Number(Boolean(status));
  const nextStage = selected
    ? stages[stages.indexOf(selected.stage) + 1]
    : undefined;
  const controls = (
    <div className="toolbar">
      <div className="toolbarLeft">
        <button
          className={"secondary " + (filters ? "isSelected" : "")}
          aria-expanded={filters}
          onClick={() => setFilters(!filters)}
        >
          <FunnelSimpleIcon size={16} aria-hidden="true" />
          Filter
          {filterCount > 0 && <span className="count">{filterCount}</span>}
        </button>
        <span className="toolbarMeta">
          {loading
            ? "Updating…"
            : `${loads.length} load${loads.length === 1 ? "" : "s"}${cursor ? " · more available" : ""}`}
        </span>
      </div>
      <div className="toolbarRight">
        <label className="search">
          <MagnifyingGlassIcon size={17} aria-hidden="true" />
          <span className="srOnly">Search loads</span>
          <input
            ref={search}
            value={q}
            onChange={(e) => filterChange({ q: e.target.value })}
            placeholder="Search reference…"
            maxLength={100}
          />
          <kbd aria-hidden="true">⌘ K</kbd>
        </label>
        <button
          className="iconButton"
          disabled={busy || loading || offline}
          aria-label="Refresh loads"
          onClick={() => act(refresh)}
        >
          <ArrowClockwiseIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
  return (
    <WorkspaceShell
      context={context}
      section={section}
      status={status}
      carrier={carrier}
      busy={busy}
      offline={offline}
      onSection={setSection}
      onQueue={showQueue}
      onCarrier={showCarrier}
      onSearch={focusSearch}
      onCreate={createLoad}
      onLogout={logout}
    >
      <header className="topbar">
        <div className="topbarLeft">
          <div className="headingGroup">
            <p className="workspaceBreadcrumb">Dispatch workspace</p>
            <h1>{section === "carriers" ? "Carriers" : queueTitle(status)}</h1>
          </div>
          {section === "loads" && (
            <div className="viewToggle" role="group" aria-label="Load view">
              <button
                aria-pressed={view === "board"}
                onClick={() => setView("board")}
              >
                <SquaresFourIcon size={15} aria-hidden="true" />
                Board
              </button>
              <button
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <ListIcon size={16} aria-hidden="true" />
                List
              </button>
            </div>
          )}
        </div>
        <div className="topbarRight">
          {canWrite && (
            <button
              className="createButton"
              disabled={offline || busy}
              onClick={createLoad}
            >
              <PlusCircleIcon size={18} aria-hidden="true" />
              Create load
            </button>
          )}
          <span className="workspaceEnvironment">
            <CircleIcon weight="fill" size={6} aria-hidden="true" />
            Local QA
          </span>
        </div>
      </header>
      <main id="main" className="workspace">
        {section === "loads" ? (
          <>
            {controls}
            {filters && (
              <div className="filterPanel">
                <label>
                  Carrier
                  <select
                    aria-label="Carrier"
                    value={carrier}
                    onChange={(e) => filterChange({ carrier: e.target.value })}
                  >
                    <option value="">All authorized carriers</option>
                    {context.carriers.map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Milestone
                  <select
                    aria-label="Milestone"
                    value={status}
                    onChange={(e) => filterChange({ status: e.target.value })}
                  >
                    <option value="">All milestones</option>
                    {stages.map((s) => (
                      <option key={s} value={s}>
                        {stageLabels[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="textButton"
                  onClick={() =>
                    filterChange({ carrier: "", status: "", q: "" })
                  }
                >
                  Clear filters
                </button>
              </div>
            )}
            {carrier && (
              <div
                className="appliedFilters"
                aria-label="Active carrier filter"
              >
                <button
                  className="scopeChip"
                  onClick={() => filterChange({ carrier: "" })}
                  aria-label="Clear carrier filter"
                >
                  <BuildingsIcon size={13} aria-hidden="true" />
                  <span>
                    {context.carriers.find((c) => c.id === carrier)?.name ||
                      "Selected carrier"}
                  </span>
                  <XIcon size={12} aria-hidden="true" />
                </button>
              </div>
            )}
            {offline && (
              <div className="alert error" role="alert">
                Offline — this view may be stale. Reconnect, then refresh.
              </div>
            )}
            {!selected && !creating && errorPanel}
            <div className="srOnly" role="status" aria-live="polite">
              {loading ? "Loading loads" : `${loads.length} loads shown`}
              {notice && ". " + notice}
            </div>
            {notice && (
              <div className="alert success">
                <CheckIcon size={17} aria-hidden="true" />
                {notice}
              </div>
            )}
            <section
              className="loadSurface"
              aria-label="Load workspace"
              aria-busy={loading}
            >
              {view === "board" ? (
                <div className="kanban">
                  {stages.map((stage) => {
                    const items = loads.filter((l) => l.stage === stage);
                    return (
                      <section
                        className={"lane " + stage}
                        key={stage}
                        aria-label={stageLabels[stage] + " loads"}
                      >
                        <div className="laneHeading">
                          <CircleIcon
                            weight="fill"
                            size={9}
                            aria-hidden="true"
                          />
                          <h2>{stageLabels[stage]}</h2>
                          <span className="laneCount">{items.length}</span>
                        </div>
                        <div className="laneCards">
                          {items.map((load) => (
                            <button
                              className="loadCard"
                              key={load.id}
                              onClick={() => open(load.id)}
                              aria-label={`${load.reference} · ${load.carrier_name || "Carrier"}`}
                              disabled={busy || loading}
                            >
                              <span className="cardTitle">
                                <TruckIcon size={17} aria-hidden="true" />
                                <strong title={load.reference}>
                                  {load.reference}
                                </strong>
                                <ArrowUpRightIcon
                                  size={14}
                                  className="cardArrow"
                                  aria-hidden="true"
                                />
                              </span>
                              <span className="cardCarrier">
                                <BuildingsIcon size={13} aria-hidden="true" />
                                {load.carrier_name}
                              </span>
                              <span className="cardRoute">
                                <span>
                                  {load.pickup || "Pickup not recorded"}
                                </span>
                                <ArrowDownIcon size={12} aria-hidden="true" />
                                <span>
                                  {load.delivery || "Delivery not recorded"}
                                </span>
                              </span>
                              <span className="cardBottom">
                                <span>
                                  {new Date(load.created_at).toLocaleDateString(
                                    "en-US",
                                    { month: "short", day: "numeric" },
                                  )}
                                </span>
                                <strong>
                                  {formatMoney(load.amount_minor)}
                                </strong>
                              </span>
                            </button>
                          ))}
                          {!items.length && (
                            <div className="laneEmpty">
                              {loading ? "Loading…" : "No loads here"}
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="tableWrap">
                  <table>
                    <caption className="srOnly">
                      Authorized loads and their milestones
                    </caption>
                    <thead>
                      <tr>
                        <th>Load / carrier</th>
                        <th>Route</th>
                        <th>Milestone</th>
                        <th>Agreed rate</th>
                        <th>
                          <span className="srOnly">Open load</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loads.map((l) => (
                        <tr key={l.id}>
                          <td>
                            <button
                              className="loadLink"
                              onClick={() => open(l.id)}
                              disabled={busy || loading}
                            >
                              {l.reference}
                            </button>
                            <small>{l.carrier_name}</small>
                          </td>
                          <td>
                            {l.pickup}
                            <small>
                              <ArrowDownIcon size={11} aria-hidden="true" />
                              {l.delivery}
                            </small>
                          </td>
                          <td>
                            <span className={"badge " + l.stage}>
                              <CircleIcon
                                size={7}
                                weight="fill"
                                aria-hidden="true"
                              />
                              {stageLabels[l.stage]}
                            </span>
                          </td>
                          <td className="money">
                            {formatMoney(l.amount_minor)}
                          </td>
                          <td>
                            <button
                              className="iconButton"
                              onClick={() => open(l.id)}
                              aria-label={"Open " + l.reference}
                              disabled={busy || loading}
                            >
                              <ArrowUpRightIcon size={17} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!loads.length && (
                    <div className="empty">
                      <MagnifyingGlassIcon size={24} aria-hidden="true" />
                      <h2>
                        {loading ? "Loading your queue…" : "No matching loads"}
                      </h2>
                      <p>Try another search or clear your filters.</p>
                    </div>
                  )}
                </div>
              )}
              {cursor && (
                <div className="pagination">
                  <button
                    className="secondary"
                    disabled={busy || loading || offline}
                    onClick={() =>
                      act(async () => {
                        const version = revision.current,
                          request = ++queueRequest.current;
                        const params = query();
                        params.set("cursor", cursor);
                        let data: Queue;
                        try {
                          data = await api<Queue>("loads?" + params);
                        } catch (e) {
                          if (
                            request === queueRequest.current &&
                            version === revision.current &&
                            active.current
                          )
                            throw e;
                          return;
                        }
                        if (
                          version !== revision.current ||
                          request !== queueRequest.current ||
                          !active.current
                        )
                          return;
                        setLoads((old) => [
                          ...old,
                          ...data.loads.filter(
                            (l) => !old.some((x) => x.id === l.id),
                          ),
                        ]);
                        setCursor(data.nextCursor);
                      })
                    }
                  >
                    Load more
                    <ArrowDownIcon size={14} aria-hidden="true" />
                  </button>
                  <small>Counts reflect the loads shown.</small>
                </div>
              )}
            </section>
          </>
        ) : (
          <CarrierDirectory
            context={context}
            onViewLoads={(id) => {
              setSection("loads");
              filterChange({ carrier: id, status: "", q: "" });
            }}
          />
        )}
        <footer>
          <span className="qa">
            <CircleIcon size={6} weight="fill" aria-hidden="true" />
            Fictional QA workspace<span className="footerDivider">·</span>No
            live tracking or integrations
          </span>
          <span>
            {updated &&
              `Updated ${updated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
            <a href="/demo.html">
              Original demo
              <ArrowUpRightIcon size={12} aria-hidden="true" />
            </a>
          </span>
        </footer>
      </main>
      {selected && (
        <Modal
          label="Load details"
          onClose={() => {
            if (!busy) {
              setSelected(null);
              setError("");
            }
          }}
        >
          <section className="inspector">
            <div className="inspectorHeader">
              <p className="eyebrow">LOAD WORKSPACE</p>
              <button
                autoFocus
                className="iconButton"
                aria-label="Close load details"
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  setError("");
                }}
              >
                <XIcon size={20} aria-hidden="true" />
              </button>
            </div>
            <h2 className="detailTitle">{selected.reference}</h2>
            <p className="detailCarrier">
              <BuildingsIcon size={15} aria-hidden="true" />
              {selectedCarrier}
            </p>
            <span className={"badge " + selected.stage}>
              <CircleIcon size={7} weight="fill" aria-hidden="true" />
              {stageLabels[selected.stage]}
            </span>
            <div className="detailFacts">
              <div>
                <small>Agreed rate</small>
                <strong>{formatMoney(selected.amount_minor)}</strong>
              </div>
              <div>
                <small>Booking source</small>
                <span>{selected.source}</span>
              </div>
            </div>
            <h3>Route & appointments</h3>
            <div className="stops">
              {selected.stops?.map((s, i) => (
                <article className="stop" key={i}>
                  <span className="stopIndex">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <small>{s.kind}</small>
                    <strong>{s.address}</strong>
                    <p>
                      <ClockIcon size={13} aria-hidden="true" />
                      {new Date(s.window_start).toLocaleString("en-US", {
                        timeZone: s.timezone,
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                    <span className="stopZone">{s.timezone}</span>
                  </div>
                </article>
              ))}
            </div>
            <h3>Driver assignment</h3>
            <div className="assignedDriver">
              <TruckIcon size={18} aria-hidden="true" />
              <span>{selected.assignment?.name || "No driver assigned"}</span>
            </div>
            {selectedRole !== "driver" && selected.stage !== "delivered" && (
              <>
                <form
                  className="assignForm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    act(async () => {
                      await api("loads/" + selected.id + "/assign", {
                        version: selected.version,
                        driverId: f.get("driver"),
                      });
                      setNotice("Driver assignment saved.");
                      setSelected(await api<Load>("loads/" + selected.id));
                      await refreshAfterSave("Driver assignment saved.");
                    });
                  }}
                >
                  <label>
                    <span className="srOnly">Authorized driver</span>
                    <select
                      name="driver"
                      required
                      defaultValue={selected.assignment?.driver_id || ""}
                    >
                      <option value="">Choose driver</option>
                      {context.drivers
                        .filter((d) => d.carrier_id === selected.carrier_id)
                        .map((d) => (
                          <option value={d.id} key={d.id}>
                            {d.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button className="secondary" disabled={busy || offline}>
                    Assign driver
                  </button>
                </form>
                {nextStage && (
                  <button
                    className="primary full nextMilestone"
                    disabled={busy || offline || !selected.assignment}
                    onClick={() =>
                      act(async () => {
                        await api("loads/" + selected.id + "/milestones", {
                          version: selected.version,
                          stage: nextStage,
                        });
                        setNotice("Milestone recorded.");
                        setSelected(await api<Load>("loads/" + selected.id));
                        await refreshAfterSave("Milestone recorded.");
                      })
                    }
                  >
                    Record next milestone
                    <ArrowRightIcon size={15} aria-hidden="true" />
                    <small>{stageLabels[nextStage]}</small>
                  </button>
                )}
              </>
            )}
            {selectedRole === "driver" && (
              <p className="helpText">
                You can view loads assigned to you. Contact dispatch for
                changes.
              </p>
            )}
            {notice && (
              <p className="inlineNotice" role="status">
                {notice}
              </p>
            )}
            {errorPanel}
            {error === "VERSION_CONFLICT" && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => open(selected.id)}
              >
                Refresh load details
              </button>
            )}
            <h3>Activity timeline</h3>
            <div className="timeline">
              {selected.events?.length ? (
                selected.events.map((e) => (
                  <p className="event" key={e.id}>
                    <CircleIcon size={7} weight="fill" aria-hidden="true" />
                    {eventLabels[e.type] || "Load updated"}
                    <small>{new Date(e.created_at).toLocaleString()}</small>
                  </p>
                ))
              ) : (
                <p className="helpText">
                  Imported fictional fixture. No operational events recorded
                  yet.
                </p>
              )}
            </div>
            <p className="detailFoot">
              Delivery does not mark documents or invoices complete.
            </p>
          </section>
        </Modal>
      )}
      {creating && (
        <Modal
          label="Create load"
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setError("");
            }
          }}
        >
          <section className="inspector">
            <div className="inspectorHeader">
              <p className="eyebrow">NEW BOOKED LOAD</p>
              <button
                autoFocus
                className="iconButton"
                aria-label="Close create load"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setError("");
                }}
              >
                <XIcon size={20} aria-hidden="true" />
              </button>
            </div>
            <h2 className="detailTitle">A clear start.</h2>
            <p className="formIntro">
              Record a booked load for an authorized carrier.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  const data = {
                    carrierId: f.get("carrier"),
                    reference: f.get("reference"),
                    source: f.get("source"),
                    amountMinor: dollarsToMinor(String(f.get("amount"))),
                    stops: ["pickup", "delivery"].map((kind) => {
                      const zone = String(f.get(kind + "Zone"));
                      const instant = appointmentToInstant(
                        String(f.get(kind + "Time")),
                        zone,
                      );
                      return {
                        kind,
                        address: f.get(kind),
                        timezone: zone,
                        windowStart: instant,
                        windowEnd: instant,
                      };
                    }),
                  };
                  const payload = JSON.stringify(data);
                  if (createRequest.current?.payload !== payload)
                    createRequest.current = {
                      payload,
                      key: crypto.randomUUID(),
                    };
                  await api("loads", data, createRequest.current.key);
                  createRequest.current = null;
                  setCreating(false);
                  await refreshAfterSave("Booked load created.");
                });
              }}
            >
              <label>
                Carrier
                <select
                  name="carrier"
                  required
                  defaultValue={carrier || undefined}
                >
                  {context.carriers
                    .filter((c) => c.role !== "driver")
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
                <span className="helpText">
                  A current verified dispatch agreement is required.
                </span>
              </label>
              <div className="formGrid">
                <label>
                  Load reference
                  <input
                    name="reference"
                    maxLength={100}
                    placeholder="e.g. RL-1048"
                    required
                  />
                </label>
                <label>
                  Agreed rate (USD)
                  <span className="currencyInput">
                    <span aria-hidden="true">$</span>
                    <input
                      name="amount"
                      inputMode="decimal"
                      placeholder="2500.00"
                      required
                    />
                  </span>
                </label>
              </div>
              <label>
                Booking source / rate confirmation reference
                <input
                  name="source"
                  maxLength={100}
                  placeholder="Broker or confirmation reference"
                  required
                />
              </label>
              {["pickup", "delivery"].map((kind, i) => (
                <fieldset key={kind}>
                  <legend>
                    <span aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {kind}
                  </legend>
                  <label>
                    Address
                    <input
                      name={kind}
                      maxLength={500}
                      placeholder={
                        kind === "pickup"
                          ? "Pickup facility and city"
                          : "Delivery facility and city"
                      }
                      required
                    />
                  </label>
                  <div className="formGrid">
                    <label>
                      Appointment
                      <input
                        name={kind + "Time"}
                        type="datetime-local"
                        required
                      />
                    </label>
                    <label>
                      Time zone
                      <select
                        name={kind + "Zone"}
                        defaultValue="America/Chicago"
                      >
                        <option value="America/New_York">Eastern</option>
                        <option value="America/Chicago">Central</option>
                        <option value="America/Denver">Mountain</option>
                        <option value="America/Phoenix">Arizona</option>
                        <option value="America/Los_Angeles">Pacific</option>
                        <option value="America/Anchorage">Alaska</option>
                        <option value="Pacific/Honolulu">Hawaii</option>
                      </select>
                    </label>
                  </div>
                  <p className="helpText">
                    Enter the appointment in this stop’s selected local time
                    zone.
                  </p>
                </fieldset>
              ))}
              {errorPanel}
              <div className="formActions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setCreating(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="primary" disabled={busy || offline}>
                  {busy ? "Saving…" : "Create booked load"}
                  <ArrowRightIcon size={15} aria-hidden="true" />
                </button>
              </div>
            </form>
          </section>
        </Modal>
      )}
    </WorkspaceShell>
  );
}
