"use client";
import { AuthLayout } from "@/components/auth-layout";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useRef } from "react";
import {
  PlusCircleIcon,
  MagnifyingGlassIcon,
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
  EnvelopeSimpleIcon,
  LockSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  ClockIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Modal } from "@/components/modal";
import {
  WorkspaceShell,
  Brand,
  queueTitle,
  QueueTabs,
  type WorkspaceSection,
  sectionTitles,
} from "@/components/workspace-shell";
import { CarrierDirectory } from "@/components/carrier-directory";
import { LoadCheckIns } from "@/components/load-check-ins";
import { DocumentPanel } from "@/components/document-panel";
import { StopList } from "@/components/stop-list";
import { CarrierDocumentsDialog } from "@/components/carrier-documents";
import { LoadExceptions } from "@/components/load-exceptions";
import { ExceptionQueue } from "@/components/exception-queue";
import { BillingWorkspace } from "@/components/billing-workspace";
import { NotificationCenter } from "@/components/notification-center";
import { AccountSettings } from "@/components/account-settings";
import { ContactsDirectory } from "@/components/contacts-directory";
import { Prospects } from "@/components/prospects";
import { Assistant } from "@/components/assistant";
import {
  DraftNote,
  RateConfirmationFill,
  type FilledDraft,
} from "@/components/rate-confirmation-fill";
import { uploadDocumentFile } from "@/lib/upload-client";
import { Inbox, type Compose } from "@/components/inbox";
import { Reports } from "@/components/reports";
import { LoadChanges } from "@/components/load-changes";
import { OrganizationSettings } from "@/components/organization-settings";
import { driverUploadTypes } from "@/lib/compliance";
import { LoadCard } from "@/components/load-card";
import {
  AttentionStrip,
  type AttentionCounts,
} from "@/components/attention-strip";
import type { AttentionKey } from "@/lib/attention";
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
  "load.check-in-correct": "Check-in corrected",
  "load.stop-arrived": "Stop arrival recorded",
  "load.stop-departed": "Stop departure recorded",
  "load.stop-arrived-corrected": "Stop arrival corrected",
  "load.stop-departed-corrected": "Stop departure corrected",
  "load.check-in-retract": "Check-in retracted",
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
    [queueFailed, setQueueFailed] = useState(false),
    [attention, setAttention] = useState<{
      counts: AttentionCounts;
      total: number;
      truncated: boolean;
      loads: Load[];
    } | null>(null),
    [attentionKey, setAttentionKey] = useState<AttentionKey | null>(null),
    [q, setQ] = useState(""),
    [carrier, setCarrier] = useState(""),
    [status, setStatus] = useState(""),
    [creating, setCreating] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [offline, setOffline] = useState(false),
    [updated, setUpdated] = useState<Date | null>(null),
    [section, setSection] = useState<WorkspaceSection>("loads"),
    [pageQ, setPageQ] = useState<Partial<Record<WorkspaceSection, string>>>({}),
    [setupCarrier, setSetupCarrier] = useState<string | null>(null),
    [docsCarrier, setDocsCarrier] = useState<string | null>(null),
    [exceptionRevision, setExceptionRevision] = useState(0),
    [unread, setUnread] = useState(0),
    [showPassword, setShowPassword] = useState(false),
    [compose, setCompose] = useState<Compose | null>(null),
    [mfaChallenge, setMfaChallenge] = useState<string | null>(null),
    [extraStops, setExtraStops] = useState<string[]>([]),
    [olderEvents, setOlderEvents] = useState<{
      loadId: string;
      events: NonNullable<Load["events"]>;
      cursor: string | null;
    } | null>(null),
    [recovering, setRecovering] = useState(false),
    [recoveryNotice, setRecoveryNotice] = useState("");
  const search = useRef<HTMLInputElement>(null),
    createRequest = useRef<{ payload: string; key: string } | null>(null),
    [filled, setFilled] = useState<FilledDraft | null>(null),
    [formKey, setFormKey] = useState(0),
    [createCarrier, setCreateCarrier] = useState(""),
    revision = useRef(0),
    active = useRef(false),
    queueRequest = useRef(0);
  const refreshUnread = useCallback(() => {
    api<{ unread: number }>("inbox/unread")
      .then((r) => setUnread(r.unread))
      .catch(() => undefined); // the badge is a convenience; the inbox shows errors
  }, [api]);
  const signedIn = !!context;
  useEffect(() => {
    if (!signedIn) return;
    refreshUnread();
    const timer = setInterval(refreshUnread, 60000);
    return () => clearInterval(timer);
  }, [signedIn, refreshUnread]);
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
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        if (search.current) search.current.focus();
        else
          // Collapsed sidebar: its search icon expands it and focuses the box.
          document
            .querySelector<HTMLButtonElement>(".sidebarSearchIcon")
            ?.click();
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
          setQueueFailed(false);
          setUpdated(new Date());
        }
      } catch (e) {
        if (!controller.signal.aborted && request === queueRequest.current) {
          setQueueFailed(true);
          handleError(e);
        }
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
  // The attention strip follows the board: refetched whenever the list is.
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    api<NonNullable<typeof attention>>(
      "loads/attention" + (carrier ? `?carrier_id=${carrier}` : ""),
      undefined,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted && active.current) setAttention(data);
      })
      .catch(() => {
        // The board reports load failures; the strip simply stays as it was.
      });
    return () => controller.abort();
  }, [context, carrier, updated, api]);
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
    setFilled(null);
    setFormKey((k) => k + 1);
    setCreateCarrier(
      carrier || context?.carriers.find((c) => c.role !== "driver")?.id || "",
    );
    setCreating(true);
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
      <AuthLayout
        topRight={
          <>
            New to Relay? <a href="/request-access">Request access</a>
          </>
        }
      >
        <section className="loginPanel">
          <h1>Sign in</h1>
          <p className="loginDescription">
            Welcome back! Pick up where you left off.
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
                    remember: f.get("remember") === "on",
                  });
                  if (result.mfa_required && result.challenge) {
                    setMfaChallenge(result.challenge);
                    return;
                  }
                  const c = await api<Context>("me");
                  active.current = true;
                  setContext(c);
                });
              }}
            >
              <div className="field">
                <label htmlFor="login-email">Email</label>
                <div className="fieldBox">
                  <EnvelopeSimpleIcon size={18} aria-hidden="true" />
                  <input
                    id="login-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@company.com"
                    required
                    maxLength={254}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="login-password">Password</label>
                <div className="fieldBox">
                  <LockSimpleIcon size={18} aria-hidden="true" />
                  <input
                    id="login-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    required
                    maxLength={256}
                  />
                  <button
                    type="button"
                    className="eyeToggle"
                    aria-label="Show password"
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? (
                      <EyeSlashIcon size={18} aria-hidden="true" />
                    ) : (
                      <EyeIcon size={18} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
              <div className="formRow">
                <label className="rememberMe">
                  <input type="checkbox" name="remember" />
                  <span>Keep me signed in for 30 days</span>
                </label>
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
              </div>
              <button className="primary full" disabled={busy || offline}>
                {busy ? "Signing in…" : "Sign in"}
                <ArrowRightIcon size={16} aria-hidden="true" />
              </button>
            </form>
          )}
          {errorPanel}
          <details className="loginAccess">
            <summary>How do I get access?</summary>
            <p>
              Open your private invitation to create an account and choose a
              password. Ask your carrier contact or dispatcher for a link. New
              dispatch organizations are approved by an administrator:{" "}
              <a href="/request-access">request access</a> and you will hear
              back. Use “Forgot password?” to reset a password by email.
            </p>
            <p>
              For the fictional QA workspace, use{" "}
              <strong>dispatcher@relay.test</strong>,{" "}
              <strong>carrier@relay.test</strong>, or{" "}
              <strong>driver@relay.test</strong> with the QA password set by
              your administrator.
            </p>
          </details>
          <p className="legalLine">
            Read the <a href="/terms">Terms</a> and{" "}
            <a href="/privacy">Privacy</a> pages.
          </p>
          {!mfaChallenge && !recovering && (
            <>
              <p className="orDivider">
                <span>or</span>
              </p>
              <a className="secondary full" href="/demo">
                Try the interactive demo
                <ArrowUpRightIcon size={14} aria-hidden="true" />
              </a>
            </>
          )}
        </section>
      </AuthLayout>
    );
  const canWrite = context.carriers.some((c) => c.role !== "driver");
  const driverOnly =
    context.carriers.length > 0 &&
    context.carriers.every((c) => c.role === "driver");
  const selectedRole = context.carriers.find(
    (c) => c.id === selected?.carrier_id,
  )?.role;
  // Older pages are kept per load and merged by id, so a refresh that
  // shifts the newest window never duplicates or drops an event.
  const olderForSelected =
    selected && olderEvents?.loadId === selected.id ? olderEvents : null;
  const timeline = [
    ...new Map(
      [...(olderForSelected?.events || []), ...(selected?.events || [])].map(
        (e) => [e.id, e],
      ),
    ).values(),
  ];
  const timelineCursor = olderForSelected
    ? olderForSelected.cursor
    : selected?.events_cursor;
  const selectedCarrier = context.carriers.find(
    (c) => c.id === selected?.carrier_id,
  )?.name;
  // Strip and filter apply to the default view only, never mid-search.
  const stripShown = section === "loads" && !q && !status && attention !== null;
  const activeKey =
    stripShown && attentionKey && attention?.counts[attentionKey]
      ? attentionKey
      : null;
  const shownLoads =
    activeKey && attention
      ? attention.loads.filter((l) =>
          l.summary?.attention.reasons.some((r) => r.key === activeKey),
        )
      : loads;
  const nextStage = selected
    ? stages[stages.indexOf(selected.stage) + 1]
    : undefined;
  const searchLabels: Partial<Record<WorkspaceSection, [string, string]>> = {
    loads: ["Search loads", "Search reference…"],
    exceptions: ["Search exceptions", "Search exceptions…"],
    inbox: ["Search conversations", "Search conversations…"],
    contacts: ["Search contacts", "Search contacts…"],
    carriers: ["Search carriers", "Search carriers…"],
    prospects: ["Search prospects", "Search prospects…"],
    assistant: ["Search conversations", "Search conversations…"],
    billing: ["Search invoices and loads", "Search invoices and loads…"],
    reports: ["Search carriers", "Search carriers…"],
  };
  const pageSearch = searchLabels[section]
    ? {
        value: section === "loads" ? q : (pageQ[section] ?? ""),
        onChange: (value: string) =>
          section === "loads"
            ? filterChange({ q: value })
            : setPageQ((old) => ({ ...old, [section]: value })),
        label: searchLabels[section]![0],
        placeholder: searchLabels[section]![1],
        inputRef: search,
      }
    : null;
  const controls = (
    <div className="toolbar">
      <div className="toolbarLeft">
        <span className="toolbarMeta">
          {loading
            ? "Updating…"
            : queueFailed && !loads.length
              ? "Couldn't load"
              : `${loads.length} load${loads.length === 1 ? "" : "s"}${cursor ? " · more available" : ""}`}
        </span>
      </div>
      <div className="toolbarRight">
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
      unread={unread}
      onSection={setSection}
      onQueue={showQueue}
      onCarrier={showCarrier}
      search={pageSearch}
      onCreate={createLoad}
      onLogout={logout}
    >
      <header className={"topbar" + (section === "loads" ? " compact" : "")}>
        {section === "loads" ? (
          <>
            <h1 className="srOnly">
              {driverOnly && !status ? "My loads" : queueTitle(status)}
            </h1>
            {controls}
          </>
        ) : (
          <div className="topbarLeft">
            <div className="headingGroup">
              <h1>{sectionTitles[section]}</h1>
            </div>
          </div>
        )}
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
            <QueueTabs
              status={status}
              driverOnly={driverOnly}
              busy={busy}
              onQueue={showQueue}
            />
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
            {stripShown && attention && (
              <AttentionStrip
                counts={attention.counts}
                total={attention.total}
                truncated={attention.truncated}
                active={activeKey}
                onToggle={setAttentionKey}
              />
            )}
            <div className="srOnly" role="status" aria-live="polite">
              {loading ? "Loading loads" : `${loads.length} loads shown`}
            </div>
            <section
              className="loadSurface"
              aria-label="Load workspace"
              aria-busy={loading}
            >
              {driverOnly && !loads.length ? (
                <div className="empty">
                  <TruckIcon size={28} aria-hidden="true" />
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
              ) : (
                <div
                  className="kanban"
                  role="region"
                  aria-label="Load board"
                  tabIndex={0}
                >
                  {stages.map((stage) => {
                    const items = shownLoads.filter((l) => l.stage === stage);
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
                            <LoadCard
                              key={load.id}
                              load={load}
                              disabled={busy || loading}
                              onOpen={open}
                            />
                          ))}
                          {!items.length && (
                            <div className="laneEmpty">
                              {loading
                                ? "Loading…"
                                : queueFailed
                                  ? "Couldn't load"
                                  : "No loads here"}
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
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
        ) : section === "contacts" ? (
          <ContactsDirectory
            query={pageQ.contacts ?? ""}
            onClearQuery={() => setPageQ((old) => ({ ...old, contacts: "" }))}
            offline={offline}
            onAuthError={handleError}
            onMessage={(entry) => {
              setCompose({ to: [entry] });
              setSection("inbox");
            }}
          />
        ) : section === "assistant" ? (
          <Assistant
            query={pageQ.assistant ?? ""}
            offline={offline}
            isAdmin={(context.organizations || []).some((o) => o.role)}
            onAuthError={handleError}
            onOpen={(source) => {
              if (source.kind === "load") void open(source.id);
              else
                setSection(
                  (
                    {
                      prospect: "prospects",
                      contact: "contacts",
                      carrier: "carriers",
                      invoice: "billing",
                      exception: "exceptions",
                    } as const
                  )[source.kind],
                );
            }}
          />
        ) : section === "prospects" ? (
          <Prospects
            query={pageQ.prospects ?? ""}
            offline={offline}
            onAuthError={handleError}
            onOpenCarriers={() => setSection("carriers")}
          />
        ) : section === "reports" ? (
          <Reports
            query={pageQ.reports ?? ""}
            carriers={context.carriers.filter((c) => c.role !== "driver")}
            onAuthError={handleError}
          />
        ) : section === "inbox" ? (
          <Inbox
            query={pageQ.inbox ?? ""}
            userId={context.user.id ?? ""}
            userName={context.user.name}
            offline={offline}
            staff={!driverOnly}
            compose={compose}
            onComposeDone={() => setCompose(null)}
            onAuthError={handleError}
            onUnreadChanged={refreshUnread}
          />
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
            query={pageQ.billing ?? ""}
            onClearQuery={() => setPageQ((old) => ({ ...old, billing: "" }))}
            context={context}
            offline={offline}
            onAuthError={handleError}
          />
        ) : section === "exceptions" ? (
          <ExceptionQueue
            query={pageQ.exceptions ?? ""}
            onClearQuery={() => setPageQ((old) => ({ ...old, exceptions: "" }))}
            revision={exceptionRevision}
            driverOnly={driverOnly}
            onAuthError={handleError}
            onOpenLoad={(id) => void open(id)}
            onShowLoads={() => setSection("loads")}
          />
        ) : (
          <CarrierDirectory
            query={pageQ.carriers ?? ""}
            onClearQuery={() => setPageQ((old) => ({ ...old, carriers: "" }))}
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
              {selected.cancelled_at
                ? "Cancelled"
                : stageLabels[selected.stage]}
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
            <StopList
              load={selected}
              canReport={!offline}
              disabled={busy || offline}
              onChanged={async (message) => {
                setSelected(await api<Load>("loads/" + selected.id));
                await refreshAfterSave(message);
              }}
            />
            <LoadChanges
              load={selected}
              canChange={
                selectedRole !== "driver" && selectedRole !== undefined
              }
              disabled={busy || offline}
              onAuthError={handleError}
              onChanged={async (message) => {
                setSelected(await api<Load>("loads/" + selected.id));
                await refreshAfterSave(message);
              }}
            />
            <h3>Driver assignment</h3>
            <div className="assignedDriver">
              <TruckIcon size={18} aria-hidden="true" />
              <span>{selected.assignment?.name || "No driver assigned"}</span>
            </div>
            {selectedRole !== "driver" &&
              selected.stage !== "delivered" &&
              !selected.cancelled_at && (
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
                      disabled={busy || offline}
                      onClick={() => {
                        // Blocked on a driver: the button leads there.
                        if (!selected.assignment) {
                          document
                            .querySelector<HTMLSelectElement>(
                              ".assignForm select",
                            )
                            ?.focus();
                          return;
                        }
                        void act(async () => {
                          await api("loads/" + selected.id + "/milestones", {
                            version: selected.version,
                            stage: nextStage,
                          });
                          setNotice("Milestone recorded.");
                          setSelected(await api<Load>("loads/" + selected.id));
                          await refreshAfterSave("Milestone recorded.");
                        });
                      }}
                    >
                      {selected.assignment
                        ? "Record next milestone"
                        : "Choose a driver to continue"}
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
              userId={context.user.id}
              role={selectedRole}
              onAmended={async (message) => {
                setSelected(await api<Load>("loads/" + selected.id));
                await refreshAfterSave(message);
              }}
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
            {selectedRole !== "driver" && (
              <button
                className="secondary"
                onClick={() => {
                  setCompose({
                    to: [],
                    suggest: selected.assignment
                      ? {
                          key: "driver:" + selected.assignment.driver_id,
                          name: selected.assignment.name,
                        }
                      : undefined,
                    subject: `About ${selected.reference}`,
                    load: { id: selected.id, reference: selected.reference },
                  });
                  setSelected(null);
                  setSection("inbox");
                }}
              >
                Message about this load
              </button>
            )}
            <h3>Documents</h3>
            <p className="helpText">
              Paperwork readiness is tracked separately from the shipment
              milestone and from billing.
            </p>
            <DocumentPanel
              slots={selected.documents || []}
              carrierId={selected.carrier_id}
              loadId={selected.id}
              recordedLoad={{
                amount_minor: selected.amount_minor,
                stops: (selected.stops || []).map((stop) => ({
                  window_start: stop.window_start,
                  window_end: stop.window_end,
                  timezone: stop.timezone,
                })),
              }}
              canUpload={(type) =>
                !offline &&
                (selectedRole !== "driver" || driverUploadTypes.includes(type))
              }
              canReview={selectedRole === "dispatcher" && !offline}
              downloads={!demo}
              demo={demo}
              disabled={busy || offline}
              onChanged={async (message) => {
                setSelected(await api<Load>("loads/" + selected.id));
                setNotice(message);
              }}
            />
            <h3>Activity timeline</h3>
            {timelineCursor && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const page = await api<{
                      events: NonNullable<Load["events"]>;
                      cursor: string | null;
                    }>(
                      `loads/${selected.id}/events?before=${encodeURIComponent(timelineCursor)}`,
                    );
                    setOlderEvents({
                      loadId: selected.id,
                      events: [
                        ...page.events,
                        ...(olderEvents?.loadId === selected.id
                          ? olderEvents.events
                          : []),
                      ],
                      cursor: page.cursor,
                    });
                  })
                }
              >
                Show older activity
              </button>
            )}
            <div className="timeline">
              {timeline.length ? (
                timeline.map((e) => (
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
            {createCarrier && (
              <RateConfirmationFill
                key={createCarrier}
                carrierId={createCarrier}
                offline={offline}
                filled={filled}
                onFilled={(f) => {
                  setFilled(f);
                  setExtraStops(
                    Array.from(
                      { length: Math.max(0, f.draft.stops.length - 2) },
                      () => "stop" + crypto.randomUUID(),
                    ),
                  );
                  setFormKey((k) => k + 1);
                }}
                onClear={() => {
                  setFilled(null);
                  setExtraStops([]);
                  setFormKey((k) => k + 1);
                }}
              />
            )}
            <form
              key={formKey}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  const data = {
                    carrierId: f.get("carrier"),
                    reference: f.get("reference"),
                    source: f.get("source"),
                    amountMinor: dollarsToMinor(String(f.get("amount"))),
                    ...(filled ? { readId: filled.read.id } : {}),
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
                  const created = await api<{ id: string }>(
                    "loads",
                    data,
                    createRequest.current.key,
                  );
                  if (filled) {
                    // The reading only drafted the form; the original file
                    // becomes the load's rate confirmation, through the
                    // normal scanned, versioned upload. If that fails the
                    // dialog stays open and Create retries both steps safely.
                    try {
                      await uploadDocumentFile(
                        api,
                        {
                          carrier_id: String(data.carrierId),
                          load_id: created.id,
                          type: "rate_confirmation",
                          idempotency_key: filled.attachKey,
                        },
                        filled.file,
                        { demo },
                      );
                    } catch {
                      throw new ApiError(502, "ATTACH_FAILED");
                    }
                  }
                  createRequest.current = null;
                  setFilled(null);
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
                  value={createCarrier}
                  onChange={(e) => {
                    setCreateCarrier(e.target.value);
                    // A reading belongs to one carrier; the values stay.
                    setFilled(null);
                  }}
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
                    defaultValue={filled?.draft.reference}
                    required
                  />
                  <DraftNote draft={filled?.draft ?? null} field="reference" />
                </label>
                <label>
                  Agreed rate (USD)
                  <span className="currencyInput">
                    <span aria-hidden="true">$</span>
                    <input
                      name="amount"
                      inputMode="decimal"
                      placeholder="2500.00"
                      defaultValue={filled?.draft.amount}
                      required
                    />
                  </span>
                  <DraftNote draft={filled?.draft ?? null} field="amount" />
                </label>
              </div>
              <label>
                Booking source / rate confirmation reference
                <input
                  name="source"
                  maxLength={100}
                  placeholder="Broker or confirmation reference"
                  defaultValue={filled?.draft.source}
                  required
                />
                <DraftNote draft={filled?.draft ?? null} field="source" />
              </label>
              {["pickup", ...extraStops, "delivery"].map((kind, i) => {
                const stopDraft =
                  filled?.draft.stops[
                    kind === "delivery" ? filled.draft.stops.length - 1 : i
                  ];
                return (
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
                          <select
                            name={kind + "Kind"}
                            defaultValue={
                              filled?.draft.stops[i]?.kind ?? "delivery"
                            }
                          >
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
                        defaultValue={
                          filled?.draft.stops[
                            kind === "delivery"
                              ? filled.draft.stops.length - 1
                              : i
                          ]?.address
                        }
                        required
                      />
                      <DraftNote
                        draft={filled?.draft ?? null}
                        field={`stop${i + 1}_address`}
                      />
                    </label>
                    <div className="formGrid">
                      <label>
                        Appointment
                        <input
                          name={kind + "Time"}
                          type="datetime-local"
                          defaultValue={stopDraft?.appointment}
                          required
                        />
                        <DraftNote
                          draft={filled?.draft ?? null}
                          field={`stop${i + 1}_appointment`}
                        />
                      </label>
                      <label>
                        Time zone
                        <select
                          name={kind + "Zone"}
                          defaultValue={stopDraft?.zone ?? "America/Chicago"}
                        >
                          <option value="America/New_York">Eastern</option>
                          <option value="America/Chicago">Central</option>
                          <option value="America/Denver">Mountain</option>
                          <option value="America/Phoenix">Arizona</option>
                          <option value="America/Los_Angeles">Pacific</option>
                          <option value="America/Anchorage">Alaska</option>
                          <option value="Pacific/Honolulu">Hawaii</option>
                        </select>
                        <DraftNote
                          draft={filled?.draft ?? null}
                          field={`stop${i + 1}_zone`}
                        />
                      </label>
                    </div>
                    <p className="helpText">
                      Enter the appointment in this stop’s selected local time
                      zone.
                    </p>
                  </fieldset>
                );
              })}
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
