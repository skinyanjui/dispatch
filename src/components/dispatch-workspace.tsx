"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useRef } from "react";
import {
  SquaresFourIcon,
  ListIcon,
  PlusCircleIcon,
  MagnifyingGlassIcon,
  FunnelSimpleIcon,
  ArrowClockwiseIcon,
  ArrowRightIcon,
  PlusIcon,
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
  sectionTitles,
} from "@/components/workspace-shell";
import { CarrierDirectory } from "@/components/carrier-directory";
import { LoadCheckIns } from "@/components/load-check-ins";
import { DocumentPanel } from "@/components/document-panel";
import { CarrierDocumentsDialog } from "@/components/carrier-documents";
import { LoadExceptions } from "@/components/load-exceptions";
import { ExceptionQueue } from "@/components/exception-queue";
import { BillingWorkspace } from "@/components/billing-workspace";
import { NotificationCenter } from "@/components/notification-center";
import { AccountSettings } from "@/components/account-settings";
import { OrganizationSettings } from "@/components/organization-settings";
import { driverUploadTypes } from "@/lib/compliance";
import { CarrierOnboarding } from "@/components/carrier-onboarding";
import {
  stages,
  stageLabels,
  type Load,
  type Context,
  type Queue,
} from "@/lib/contracts";
import { dollarsToMinor, appointmentToInstant, formatMoney } from "@/lib/entry";

import { useApi, ApiError, describe } from "@/lib/client-api";
const eventLabels: Record<string, string> = {
  "load.created": "Load created",
  "load.assign": "Driver assigned",
  "load.milestones": "Milestone recorded",
  "load.check-in": "Manual check-in recorded",
  "document.uploaded": "Document uploaded",
  "document.reviewed": "Document reviewed",
  "exception.opened": "Exception flagged",
  "exception.assigned": "Exception owner changed",
  "exception.started": "Exception work started",
  "exception.resolved": "Exception resolved",
  "exception.reopened": "Exception reopened",
  "billing.packet_saved": "Billing packet saved",
  "billing.packet_submitted": "Billing packet submitted",
  "billing.carrier_receipt_recorded": "Carrier receipt recorded",
};

function appointmentLabel(start: string, end: string, timezone: string) {
  const format = (value: string) =>
    new Date(value).toLocaleString("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  return new Date(start).getTime() === new Date(end).getTime()
    ? format(start)
    : `${format(start)} – ${format(end)}`;
}

export default function Workspace({ demo = false }: { demo?: boolean } = {}) {
  const api = useApi();
  const router = useRouter();
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
    [section, setSection] = useState<WorkspaceSection>("loads"),
    [setupCarrier, setSetupCarrier] = useState<string | null>(null),
    [docsCarrier, setDocsCarrier] = useState<string | null>(null),
    [exceptionRevision, setExceptionRevision] = useState(0),
    [mfaChallenge, setMfaChallenge] = useState<string | null>(null),
    [extraStops, setExtraStops] = useState<string[]>([]),
    [recovering, setRecovering] = useState(false),
    [recoveryNotice, setRecoveryNotice] = useState("");
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
      setSetupCarrier(null);
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
  }, [query, api]);
  useEffect(() => {
    api<Context>("me")
      .then((c) => {
        active.current = true;
        setContext(c);
        if (c.carriers.length && c.carriers.every((v) => v.role === "driver"))
          setView("list");
        if (
          new URLSearchParams(window.location.search).get("view") ===
            "carriers" &&
          c.carriers.some((v) => v.role !== "driver")
        )
          setSection("carriers");
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
  }, [handleError, api]);
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    const request = ++queueRequest.current;
    const timer = setTimeout(async () => {
      if (request !== queueRequest.current) return;
      setLoading(true);
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
  }, [context, query, handleError, api]);
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
    setError("");
    setLoading(true);
    setQ(next.q);
    setCarrier(next.carrier);
    setStatus(next.status);
  }
  function createLoad() {
    if (busy || offline || selected || creating || setupCarrier) return;
    createRequest.current = null;
    setError("");
    setExtraStops([]);
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
    await act(async () => {
      const [load, c] = await Promise.all([
        api<Load>("loads/" + id),
        api<Context>("me"),
      ]);
      setContext(c);
      setSelected(load);
    });
  }
  async function logout() {
    if (demo) {
      router.push("/");
      return;
    }
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
      {context && !selected && !creating && section === "loads" && (
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
          {mfaChallenge ? (
            <form
              aria-label="Two-step verification"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  try {
                    await api("login/mfa", {
                      challenge: mfaChallenge,
                      code: String(f.get("code")).trim(),
                    });
                  } catch (err) {
                    if (
                      err instanceof ApiError &&
                      ["MFA_CHALLENGE_EXPIRED", "TRY_AGAIN_LATER"].includes(
                        err.message,
                      )
                    )
                      setMfaChallenge(null);
                    throw err;
                  }
                  setMfaChallenge(null);
                  const c = await api<Context>("me");
                  active.current = true;
                  setContext(c);
                  if (
                    c.carriers.length &&
                    c.carriers.every((v) => v.role === "driver")
                  )
                    setView("list");
                });
              }}
            >
              <label>
                Authentication code
                <input
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="text"
                  required
                  maxLength={40}
                  autoFocus
                />
                <small>
                  Enter the 6-digit code from your authenticator app, or one of
                  your recovery codes.
                </small>
              </label>
              <button className="primary full" disabled={busy || offline}>
                {busy ? "Verifying…" : "Verify and sign in"}
                <ArrowRightIcon size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="textButton"
                onClick={() => {
                  setMfaChallenge(null);
                  setError("");
                }}
              >
                Use a different account
              </button>
            </form>
          ) : recovering ? (
            <form
              aria-label="Reset password"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  await api("password-reset/request", {
                    email: String(f.get("email")).trim(),
                  });
                  setRecoveryNotice(
                    "If an account uses that email, a reset link is on its way. It expires in one hour.",
                  );
                });
              }}
            >
              <label>
                Account email
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  autoFocus
                />
              </label>
              <button className="primary full" disabled={busy || offline}>
                {busy ? "Sending…" : "Email me a reset link"}
              </button>
              {recoveryNotice && (
                <p className="inlineNotice" role="status">
                  {recoveryNotice}
                </p>
              )}
              <button
                type="button"
                className="textButton"
                onClick={() => {
                  setRecovering(false);
                  setRecoveryNotice("");
                  setError("");
                }}
              >
                Back to sign in
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  const result = await api<{
                    ok?: boolean;
                    mfa_required?: boolean;
                    challenge?: string;
                  }>("login", {
                    email: f.get("email"),
                    password: f.get("password"),
                  });
                  if (result.mfa_required && result.challenge) {
                    setMfaChallenge(result.challenge);
                    return;
                  }
                  const c = await api<Context>("me");
                  active.current = true;
                  setContext(c);
                  if (
                    c.carriers.length &&
                    c.carriers.every((v) => v.role === "driver")
                  )
                    setView("list");
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
              <button
                type="button"
                className="textButton"
                onClick={() => {
                  setRecovering(true);
                  setError("");
                }}
              >
                Forgot password?
              </button>
            </form>
          )}
          {errorPanel}
          <details className="loginAccess">
            <summary>How do I get access?</summary>
            <p>
              Open your private invitation to create an account and choose a
              password. Ask your carrier contact or dispatcher for a link.
              Public signup is not available; new dispatch organizations are set
              up by an administrator. Use “Forgot password?” to reset a password
              by email.
            </p>
            <p>
              For the fictional QA workspace, use{" "}
              <strong>dispatcher@relay.test</strong>,{" "}
              <strong>carrier@relay.test</strong>, or{" "}
              <strong>driver@relay.test</strong> with the QA password set by
              your administrator.
            </p>
          </details>
          <p className="loginFoot">
            Fictional QA data. No live freight connections.
            <br />
            <a href="/demo">
              Try interactive demo{" "}
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
  const driverOnly =
    context.carriers.length > 0 &&
    context.carriers.every((c) => c.role === "driver");
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
      busy={busy || !!setupCarrier}
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
            <p className="workspaceBreadcrumb">
              {driverOnly ? "Driver workspace" : "Dispatch workspace"}
            </p>
            <h1>
              {section !== "loads"
                ? sectionTitles[section]
                : driverOnly && !status
                  ? "My loads"
                  : queueTitle(status)}
            </h1>
          </div>
          {section === "loads" && !driverOnly && (
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
          {canWrite && section === "loads" && (
            <button
              className="createButton"
              disabled={offline || busy || !!setupCarrier}
              onClick={createLoad}
            >
              <PlusCircleIcon size={18} aria-hidden="true" />
              Create load
            </button>
          )}
          <span className="workspaceEnvironment">
            <CircleIcon weight="fill" size={6} aria-hidden="true" />
            {demo ? "Interactive demo" : "QA workspace"}
          </span>
        </div>
      </header>
      <main id="main" className="workspace">
        {offline && (
          <div className="alert error" role="alert">
            Offline — this view may be stale. Reconnect, then refresh.
          </div>
        )}
        {!selected && !creating && errorPanel}
        {!selected && !creating && notice && (
          <div className="alert success" role="status">
            <CheckIcon size={17} aria-hidden="true" />
            {notice}
          </div>
        )}
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
            <div className="srOnly" role="status" aria-live="polite">
              {loading ? "Loading loads" : `${loads.length} loads shown`}
            </div>
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
                                  {(load.stop_count ?? 2) > 2 &&
                                    ` · ${load.stop_count} stops`}
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
              ) : driverOnly ? (
                <div className="driverLoadCards">
                  {loads.map((l) => (
                    <button
                      className="driverLoadCard"
                      key={l.id}
                      aria-label={`${l.reference} · ${l.carrier_name}`}
                      disabled={busy || loading}
                      onClick={() => open(l.id)}
                    >
                      <span className="driverCardHeading">
                        <strong>{l.reference}</strong>
                        <span className={"badge " + l.stage}>
                          {stageLabels[l.stage]}
                        </span>
                      </span>
                      <span className="driverCardRoute">
                        {l.pickup}
                        <ArrowRightIcon size={15} />
                        {l.delivery}
                        {(l.stop_count ?? 2) > 2 && ` · ${l.stop_count} stops`}
                      </span>
                      <span className="driverCardFoot">
                        {l.carrier_name}
                        <span>
                          View load
                          <ArrowUpRightIcon size={14} />
                        </span>
                      </span>
                    </button>
                  ))}
                  {!loads.length && (
                    <div className="empty">
                      <TruckIcon size={28} />
                      <h2>
                        {loading
                          ? "Loading your loads…"
                          : q
                            ? "No matching loads"
                            : "No assigned loads yet"}
                      </h2>
                      <p>
                        {q
                          ? "Try another reference."
                          : "Your dispatcher will assign your loads here. You can return when you are ready."}
                      </p>
                    </div>
                  )}
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
                        {!driverOnly && <th>Agreed rate</th>}
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
                              aria-label={`${l.reference} · ${l.carrier_name}`}
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
                              {(l.stop_count ?? 2) > 2 &&
                                ` · ${l.stop_count} stops`}
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
                          {!driverOnly && (
                            <td className="money">
                              {formatMoney(l.amount_minor)}
                            </td>
                          )}
                          <td>
                            <button
                              className="iconButton"
                              onClick={() => open(l.id)}
                              aria-label={`Open ${l.reference} · ${l.carrier_name}`}
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
                        {loading
                          ? "Loading your queue…"
                          : driverOnly && !q
                            ? "No assigned loads yet"
                            : "No matching loads"}
                      </h2>
                      <p>
                        {driverOnly && !q
                          ? "Your dispatcher will assign your loads here. You can return when you are ready."
                          : "Try another search or clear your filters."}
                      </p>
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
        ) : section === "account" ? (
          <AccountSettings onAuthError={handleError} />
        ) : section === "organization" ? (
          <OrganizationSettings
            context={context}
            onAuthError={handleError}
            onChanged={async () => setContext(await api<Context>("me"))}
          />
        ) : section === "notifications" ? (
          <NotificationCenter
            isDispatcher={context.carriers.some((c) => c.role === "dispatcher")}
            driverOnly={driverOnly}
            onAuthError={handleError}
          />
        ) : section === "billing" ? (
          <BillingWorkspace
            context={context}
            offline={offline}
            onAuthError={handleError}
          />
        ) : section === "exceptions" ? (
          <ExceptionQueue
            revision={exceptionRevision}
            driverOnly={driverOnly}
            onAuthError={handleError}
            onOpenLoad={(id) => void open(id)}
          />
        ) : (
          <CarrierDirectory
            context={context}
            busy={busy || offline}
            onAdd={() => setSetupCarrier("new")}
            onSetup={setSetupCarrier}
            onDocuments={setDocsCarrier}
            onViewLoads={(id) => {
              setSection("loads");
              filterChange({ carrier: id, status: "", q: "" });
            }}
          />
        )}
        <footer>
          <span className="qa">
            <CircleIcon size={6} weight="fill" aria-hidden="true" />
            {demo
              ? "Demo · sample data on this device"
              : "Fictional QA workspace"}
            <span className="footerDivider">·</span>No live tracking or
            integrations
          </span>
          <span>
            {updated &&
              `Updated ${updated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
            <a href={demo ? "/" : "/demo"}>
              {demo ? "Open Relay" : "Interactive demo"}
              <ArrowUpRightIcon size={12} aria-hidden="true" />
            </a>
          </span>
        </footer>
      </main>
      {docsCarrier && (
        <CarrierDocumentsDialog
          carrierId={docsCarrier}
          carrierName={
            context.carriers.find((c) => c.id === docsCarrier)?.name || ""
          }
          demo={demo}
          offline={offline}
          onClose={() => setDocsCarrier(null)}
          onAuthError={handleError}
        />
      )}
      {setupCarrier && (
        <CarrierOnboarding
          demo={demo}
          carrierId={setupCarrier}
          context={context}
          onClose={() => setSetupCarrier(null)}
          onAuthError={handleError}
          onChanged={async () => {
            setContext(await api<Context>("me"));
          }}
        />
      )}
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
                      <span>
                        {appointmentLabel(
                          s.window_start,
                          s.window_end,
                          s.timezone,
                        )}
                      </span>
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
                You can record manual check-ins for your assigned loads. Contact
                dispatch for other changes.
              </p>
            )}
            {notice && (
              <p className="inlineNotice" role="status">
                {notice}
              </p>
            )}
            {errorPanel}
            {error && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => open(selected.id)}
              >
                Refresh load details
              </button>
            )}
            <LoadCheckIns
              key={selected.id}
              load={selected}
              busy={busy}
              offline={offline}
              onRecord={async (input) => {
                let result: "saved" | "retry" | "version-conflict" = "retry";
                await act(async () => {
                  let response: { version: number };
                  try {
                    response = await api<{ version: number }>(
                      "loads/" + selected.id + "/check-ins",
                      input,
                    );
                  } catch (e) {
                    if (
                      e instanceof ApiError &&
                      e.message === "VERSION_CONFLICT"
                    )
                      result = "version-conflict";
                    throw e;
                  }
                  result = "saved";
                  setNotice("Manual check-in recorded.");
                  setSelected(
                    (current) =>
                      current && {
                        ...current,
                        version: Math.max(current.version, response.version),
                      },
                  );
                  setSelected(await api<Load>("loads/" + selected.id));
                  await refreshAfterSave("Manual check-in recorded.");
                });
                return result;
              }}
            />
            <LoadExceptions
              load={selected}
              role={selectedRole}
              disabled={busy || offline}
              onChanged={async (message) => {
                setExceptionRevision((r) => r + 1);
                setSelected(await api<Load>("loads/" + selected.id));
                setNotice(message);
              }}
            />
            <h3>Documents</h3>
            <p className="helpText">
              Paperwork readiness is tracked separately from the shipment
              milestone and from billing.
            </p>
            <DocumentPanel
              slots={selected.documents || []}
              carrierId={selected.carrier_id}
              loadId={selected.id}
              canUpload={(type) =>
                !offline &&
                (selectedRole !== "driver" || driverUploadTypes.includes(type))
              }
              canReview={selectedRole === "dispatcher" && !offline}
              downloads={!demo}
              disabled={busy || offline}
              onChanged={async (message) => {
                setSelected(await api<Load>("loads/" + selected.id));
                setNotice(message);
              }}
            />
            <h3>Activity timeline</h3>
            {selected.events_truncated && (
              <p className="helpText">
                Showing the latest 100 activity events. Earlier history is
                retained.
              </p>
            )}
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
                    stops: ["pickup", ...extraStops, "delivery"].map((key) => {
                      const zone = String(f.get(key + "Zone"));
                      const instant = appointmentToInstant(
                        String(f.get(key + "Time")),
                        zone,
                      );
                      return {
                        kind:
                          key === "pickup" || key === "delivery"
                            ? key
                            : String(f.get(key + "Kind")),
                        address: f.get(key),
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
              {["pickup", ...extraStops, "delivery"].map((kind, i) => (
                <fieldset key={kind}>
                  <legend>
                    <span aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {kind === "pickup" || kind === "delivery"
                      ? kind
                      : `Stop ${i + 1}`}
                  </legend>
                  {kind !== "pickup" && kind !== "delivery" && (
                    <div className="formGrid">
                      <label>
                        Stop type
                        <select name={kind + "Kind"} defaultValue="delivery">
                          <option value="pickup">Pickup</option>
                          <option value="delivery">Delivery</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="textButton"
                        aria-label={`Remove stop ${i + 1}`}
                        onClick={() =>
                          setExtraStops((s) => s.filter((v) => v !== kind))
                        }
                      >
                        Remove stop
                      </button>
                    </div>
                  )}
                  <label>
                    Address
                    <input
                      name={kind}
                      maxLength={500}
                      placeholder={
                        kind === "delivery"
                          ? "Delivery facility and city"
                          : "Facility and city"
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
              {extraStops.length < 8 && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setExtraStops((s) => [...s, "stop" + crypto.randomUUID()])
                  }
                >
                  <PlusIcon size={15} aria-hidden="true" />
                  Add stop before final delivery
                </button>
              )}
              <p className="helpText">
                Stops run in order: the first is a pickup, the last a delivery,
                and each appointment is no earlier than the one before.
              </p>
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
