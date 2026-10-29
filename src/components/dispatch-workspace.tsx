"use client";
import { readFilters, filterSearch, type WorkspaceFilters } from "@/lib/routes";
import { AuthLayout } from "@/components/auth-layout";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  PlusIcon,
  ArrowDownIcon,
  BuildingsIcon,
  TruckIcon,
  XIcon,
  CircleIcon,
  CheckIcon,
  AppleLogoIcon,
  ArrowUpRightIcon,
  GoogleLogoIcon,
  EnvelopeSimpleIcon,
  LockSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Modal } from "@/components/modal";
import {
  WorkspaceShell,
  queueTitle,
  QueueTabs,
  type WorkspaceSection,
  sectionTitles,
} from "@/components/workspace-shell";
import { CarrierDirectory } from "@/components/carrier-directory";
type RecordTab =
  | "timeline"
  | "route"
  | "check-ins"
  | "documents"
  | "exceptions"
  | "notes"
  | "claims";
import { DocumentsPage } from "@/components/documents-page";
import { LoadDraft } from "@/components/load-draft";
import { LoadsViewBar } from "@/components/loads-view-bar";
import {
  CalendarView,
  defaultView,
  TableView,
  Totals,
  type ViewConfig,
} from "@/components/loads-views";
import { LoadNotes } from "@/components/load-notes";
import { LoadClaimsTab } from "@/components/load-claims";
import { ApprovalsWaiting } from "@/components/approvals-waiting";
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
import { Inbox, type Compose, type InboxCounts } from "@/components/inbox";
import { ReportInvoices } from "@/components/report-invoices";
import { Reports } from "@/components/reports";
import { LoadChanges } from "@/components/load-changes";
import { OrganizationSettings } from "@/components/organization-settings";
import { AuditLog } from "@/components/audit-log";
import { AssignVehicleSelect, FleetPage } from "@/components/fleet";
import { driverUploadTypes } from "@/lib/compliance";
import { Board } from "@/components/board";
import { TabPanel, Tabs } from "@/components/ui/tabs";
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
  type Stage,
  type Context,
  type Queue,
} from "@/lib/contracts";
import { dollarsToMinor, appointmentToInstant, formatMoney } from "@/lib/entry";

import { useApi, ApiError, describe } from "@/lib/client-api";
import { pathFor, parsePath, sectionAllowed, type Route } from "@/lib/routes";
import { browserStore, recordVisit } from "@/lib/most-used";
import { ErrorAlert } from "@/components/ui/feedback";
import { formatDate, formatDateTimeLong, formatTime } from "@/lib/format";
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

/**
 * Sign-in over the workspace after a session ends. A native modal dialog, so
 * it stacks above any drawer already open (those are top-layer dialogs too),
 * makes everything behind it inert, and cannot be dismissed with Escape.
 */
function ExpiredSignIn({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="login sessionOverlay"
      aria-label="Session expired"
      onCancel={(e) => e.preventDefault()}
    >
      {children}
    </dialog>
  );
}

export default function Workspace({
  demo = false,
  initialRoute,
}: {
  demo?: boolean;
  /** The address the page was opened at (ADR 0045); ignored in the demo. */
  initialRoute?: Route;
} = {}) {
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
    [scopes, setScopes] = useState<
      Partial<Record<WorkspaceSection, WorkspaceFilters>>
    >({}),
    [loadScope, setLoadScope] = useState<WorkspaceFilters>({}),
    [attentionKey, setAttentionKey] = useState<AttentionKey | null>(null),
    [view, setView] = useState<ViewConfig>(defaultView),
    [recordTab, setRecordTab] = useState<RecordTab>("timeline"),
    [draftToOpen, setDraftToOpen] = useState<string | null>(null),
    [q, setQ] = useState(""),
    [carrier, setCarrier] = useState(""),
    [status, setStatus] = useState(""),
    [creating, setCreating] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [offline, setOffline] = useState(false),
    [updated, setUpdated] = useState<Date | null>(null),
    [expired, setExpired] = useState(false),
    [chosenSection, setSection] = useState<WorkspaceSection>(
      demo ? "loads" : (initialRoute?.section ?? "loads"),
    ),
    [invoiceTarget, setInvoiceTarget] = useState<string | null>(null),
    [urlReady, setUrlReady] = useState(false),
    [navTick, setNavTick] = useState(0),
    [pageQ, setPageQ] = useState<Partial<Record<WorkspaceSection, string>>>({}),
    [setupCarrier, setSetupCarrier] = useState<string | null>(null),
    [docsCarrier, setDocsCarrier] = useState<string | null>(null),
    [exceptionRevision, setExceptionRevision] = useState(0),
    [unread, setUnread] = useState(0),
    [inboxFolder, setInboxFolder] = useState("all"),
    [inboxCounts, setInboxCounts] = useState<InboxCounts | null>(null),
    [showPassword, setShowPassword] = useState(false),
    [compose, setCompose] = useState<Compose | null>(null),
    [mfaChallenge, setMfaChallenge] = useState<string | null>(() => {
      // A Google or Apple sign-in for an account with two-step verification
      // comes back with the challenge in the address fragment.
      if (typeof window === "undefined") return null;
      return /^#mfa=([0-9a-f]{64})$/.exec(window.location.hash)?.[1] ?? null;
    }),
    [providers, setProviders] = useState<{
      google: boolean;
      apple: boolean;
    } | null>(null),
    [socialNote] = useState<{ requested: boolean; error: string }>(() => {
      if (typeof window === "undefined") return { requested: false, error: "" };
      const q = new URLSearchParams(window.location.search);
      return {
        requested: q.get("social") === "requested",
        error: /^[A-Z_]{3,40}$/.test(q.get("social_error") ?? "")
          ? (q.get("social_error") as string)
          : "",
      };
    }),
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
    queueRequest = useRef(0),
    contextRef = useRef<Context | null>(null),
    expiredUser = useRef<string | null>(null),
    deepLink = useRef<Route | undefined>(demo ? undefined : initialRoute),
    navigating = useRef(false),
    replaceNext = useRef(false);
  // The page shown. An address can name a page this person may not open; it is
  // never mounted, so it never fires its data requests (applyRoute explains).
  const section: WorkspaceSection = context?.mfa_required
    ? "account"
    : context && !sectionAllowed(chosenSection, context)
      ? "loads"
      : chosenSection;
  const sectionRef = useRef(section);
  useEffect(() => {
    sectionRef.current = section;
  }, [section]);
  // What the logo learns from: one visit per page opened, counted here only.
  const visitor = context
    ? (context.user.id ?? context.user.email ?? "demo")
    : null;
  useEffect(() => {
    if (visitor) recordVisit(browserStore(), visitor, section);
  }, [section, visitor]);
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
        ...loadScope,
        ...(status ? { status } : {}),
      }),
    [q, carrier, status, loadScope],
  );
  const handleSignedOutError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      if (active.current)
        deepLink.current =
          parsePath(window.location.pathname.split("/").filter(Boolean)) ??
          undefined;
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
  const handleError = useCallback(
    (e: unknown) => {
      const who = contextRef.current;
      if (e instanceof ApiError && e.status === 401 && who && !demo) {
        // Only these two mean the session itself ended; anything else on a 401
        // (a wrong password while signing back in) is an ordinary error.
        if (["AUTH_REQUIRED", "SESSION_EXPIRED"].includes(e.message)) {
          // Keep the workspace and anything typed into it; sign-in appears over
          // it (see signInPanel). A second 401 while it is up changes nothing.
          expiredUser.current ??=
            who.user.id ?? who.user.email ?? who.user.name;
          // Open dialogs keep their drafts, but loaded business data must not
          // outlive the session: the loads list is cleared (and reloads after
          // the same person signs in again), as it is on a full sign-out.
          setLoads([]);
          setCursor(null);
          setUpdated(null);
          queueRequest.current++;
          setExpired(true);
          setBusy(false);
          return;
        }
        setError(e.message);
        return;
      }
      handleSignedOutError(e);
    },
    [demo, handleSignedOutError],
  );
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
    // The one-time hints from a social sign-in are not kept in the address bar.
    if (
      /[?&]social(_error)?=/.test(window.location.search) ||
      window.location.hash
    )
      window.history.replaceState(null, "", window.location.pathname);
    api<{ google: boolean; apple: boolean }>("auth/providers")
      .then(setProviders)
      .catch(() => setProviders({ google: false, apple: false }));
    api<Context>("me")
      .then((c) => {
        active.current = true;
        // Older links say /?view=carriers; they mean the Carriers page.
        if (
          new URLSearchParams(window.location.search).get("view") ===
            "carriers" &&
          c.carriers.some((v) => v.role !== "driver") &&
          !deepLink.current?.loadId
        ) {
          if (demo) setSection("carriers");
          else deepLink.current = { section: "carriers" };
        }
        setContext(c);
      })
      .catch((e) => {
        if (e.message !== "AUTH_REQUIRED" && e.message !== "SESSION_EXPIRED")
          handleError(e);
      })
      .finally(() => setReady(true));
    const connection = () => setOffline(!navigator.onLine);
    const keyboard = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
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
  }, [handleError, api, demo]);
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
          // The loads list is the Loads page's own business: another page does
          // not show its failure as a banner (opening Loads retries it).
          if (
            (e instanceof ApiError && e.status === 401) ||
            sectionRef.current === "loads"
          )
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
  // A failed loads request is retried when the person opens Loads; the retry
  // sets state after its response.
  useEffect(() => {
    if (section === "loads" && queueFailed && context && !loading && !busy)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void act(refresh);
    // Only entering Loads should retry, not every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  /** Opens a load from an address. A load that is missing and one that is
   *  not yours read the same. */
  const loadFromLink = useCallback(
    async (id: string) => {
      try {
        const load = await api<Load>("loads/" + id);
        setRecordTab("timeline");
        setSelected(load);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) handleError(e);
        else {
          setSelected(null);
          setError("NOT_FOUND");
        }
      }
    },
    [api, handleError],
  );
  /** Puts the workspace where an address says (first load, Back, Forward).
   *  Anything the person may not open falls back to Loads. */
  const applyRoute = useCallback(
    async (r: Route) => {
      const who = contextRef.current;
      if (!who) return;
      navigating.current = true;
      // The browser is already at the address; a correction replaces it.
      replaceNext.current = true;
      try {
        const allowed = sectionAllowed(r.section, who);
        const next = allowed ? r.section : "loads";
        if (!allowed) setError("NOT_FOUND");
        setSection(next);
        const filters = readFilters(window.location.search);
        setScopes((old) => ({ ...old, [next]: filters }));
        if (next === "loads") {
          setQ(filters.q ?? "");
          setCarrier(filters.carrier_id ?? "");
          setStatus(
            [
              "booked",
              "dispatched",
              "picked-up",
              "delivered",
              "cancelled",
            ].includes(filters.status)
              ? filters.status
              : "",
          );
          const {
            q: ignoredQ,
            carrier_id: ignoredCarrier,
            status: ignoredStatus,
            ...rest
          } = filters;
          void ignoredQ;
          void ignoredCarrier;
          void ignoredStatus;
          setLoadScope(rest);
        }
        setInvoiceTarget(next === "billing" ? (r.invoiceId ?? null) : null);
        const carrierOk =
          next === "carriers" &&
          !!r.carrierId &&
          who.carriers.some((c) => c.id === r.carrierId && c.role !== "driver");
        if (r.carrierId && next === "carriers" && !carrierOk)
          setError("NOT_FOUND");
        setSetupCarrier(
          carrierOk && r.carrierPanel === "setup" ? r.carrierId! : null,
        );
        setDocsCarrier(
          carrierOk && r.carrierPanel === "documents" ? r.carrierId! : null,
        );
        if (allowed && r.loadId) await loadFromLink(r.loadId);
        else setSelected(null);
      } finally {
        navigating.current = false;
        setNavTick((t) => t + 1);
      }
    },
    [loadFromLink],
  );
  useEffect(() => {
    contextRef.current = context;
  }, [context]);
  useEffect(() => {
    // The address the page opened at is applied once, after sign-in.
    if (demo || !context) return;
    const route = deepLink.current;
    deepLink.current = undefined;
    if (!route) {
      setUrlReady(true);
      return;
    }
    void applyRoute(route).finally(() => setUrlReady(true));
  }, [demo, context, applyRoute]);
  useEffect(() => {
    // Back and Forward.
    if (demo || !urlReady) return;
    const onPop = () => {
      const route = parsePath(
        window.location.pathname.split("/").filter(Boolean),
      );
      void applyRoute(route ?? { section: "loads" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [demo, urlReady, applyRoute]);
  useEffect(() => {
    // The address follows what is open, one history entry per change.
    if (demo || !context || !urlReady || navigating.current) return;
    const route: Route = selected
      ? { section: "loads", loadId: selected.id }
      : section === "billing" && invoiceTarget
        ? { section: "billing", invoiceId: invoiceTarget }
        : section === "carriers" && setupCarrier && setupCarrier !== "new"
          ? {
              section: "carriers",
              carrierId: setupCarrier,
              carrierPanel: "setup",
            }
          : section === "carriers" && docsCarrier
            ? {
                section: "carriers",
                carrierId: docsCarrier,
                carrierPanel: "documents",
              }
            : { section };
    const routeFilters = selected
      ? Object.fromEntries(
          Object.entries(scopes[section] ?? {}).filter(([key]) =>
            ["from", "to", "carrier_id"].includes(key),
          ),
        )
      : section === "loads"
        ? {
            ...loadScope,
            ...(q ? { q } : {}),
            ...(carrier ? { carrier_id: carrier } : {}),
            ...(status ? { status } : {}),
          }
        : (scopes[section] ?? {});
    const path = pathFor(route) + filterSearch(routeFilters);
    if (window.location.pathname + window.location.search !== path)
      window.history[replaceNext.current ? "replaceState" : "pushState"](
        null,
        "",
        path,
      );
    replaceNext.current = false;
    document.title = selected
      ? `Load ${selected.reference} · Relay`
      : `${section === "loads" ? "Loads" : sectionTitles[section]} · Relay`;
  }, [
    demo,
    context,
    urlReady,
    navTick,
    selected,
    invoiceTarget,
    section,
    setupCarrier,
    docsCarrier,
    scopes,
    loadScope,
    q,
    carrier,
    status,
  ]);
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
  /** Drag a card to the next column: the same milestone as the drawer button. */
  async function moveLoad(id: string, target: Stage) {
    const load = loads.find((l) => l.id === id);
    if (!load || load.stage === target) return;
    const role = context?.carriers.find((c) => c.id === load.carrier_id)?.role;
    if (role === "driver" || load.cancelled_at) return;
    if (stages[stages.indexOf(load.stage) + 1] !== target) {
      setNotice("");
      setError("MOVE_ONE_STEP");
      return;
    }
    if (!load.summary?.driver_name) {
      setNotice("");
      setError("ASSIGN_DRIVER_FIRST");
      return;
    }
    await act(async () => {
      await api("loads/" + id + "/milestones", {
        version: load.version,
        stage: target,
      });
      await refreshAfterSave(
        `${load.reference} moved to ${stageLabels[target]}.`,
      );
    });
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
    if (selected?.id !== id) setRecordTab("timeline");
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
      deepLink.current = undefined;
      window.history.replaceState(null, "", "/");
      revision.current++;
      queueRequest.current++;
      setSection("loads");
      setContext(null);
      setLoads([]);
      setSelected(null);
      setCreating(false);
      setQ("");
      setScopes({});
      setLoadScope({});
      setCarrier("");
      setStatus("");
      setCursor(null);
      setUpdated(null);
    });
  }
  const errorPanel = error ? (
    <ErrorAlert>
      <WarningCircleIcon size={18} aria-hidden="true" />
      <span>{describe(error)}</span>
      {/* Retrying cannot change "not available to your account". */}
      {context && !selected && !creating && error !== "NOT_FOUND" && (
        <button
          className="textButton"
          disabled={busy}
          onClick={() => act(refresh)}
        >
          Retry
        </button>
      )}
    </ErrorAlert>
  ) : null;
  /** Sign-in succeeded. After an expired session the same person goes back to
   *  the workspace as they left it; anyone else gets a fresh page, so they
   *  never inherit the previous person's screen. */
  function completeSignIn(c: Context) {
    if (expired) {
      const same =
        (c.user.id ?? c.user.email ?? c.user.name) === expiredUser.current;
      if (!same) {
        window.location.reload();
        return;
      }
      expiredUser.current = null;
      setExpired(false);
      setError("");
    }
    active.current = true;
    setContext(c);
  }
  const signInPanel = (
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
              completeSignIn(await api<Context>("me"));
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
              Enter the 6-digit code from your authenticator app, or one of your
              recovery codes.
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
              completeSignIn(await api<Context>("me"));
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
      {socialNote.requested && (
        <p className="inlineNotice" role="status">
          Thanks. You don&apos;t have a Relay account yet, so we recorded a
          request for access with your verified email. Nothing was created; a
          person reviews it.
        </p>
      )}
      <ErrorAlert error={socialNote.error} />
      <details className="loginAccess">
        <summary>How do I get access?</summary>
        <p>
          Open your private invitation to create an account and choose a
          password. Ask your carrier contact or dispatcher for a link. New
          dispatch organizations are approved by an administrator:{" "}
          <a href="/request-access">request access</a> and you will hear back.
          Use “Forgot password?” to reset a password by email.
        </p>
        <p>
          For the fictional QA workspace, use{" "}
          <strong>dispatcher@relay.test</strong>,{" "}
          <strong>carrier@relay.test</strong>, or{" "}
          <strong>driver@relay.test</strong> with the QA password set by your
          administrator.
        </p>
      </details>
      <p className="legalLine">
        Read the <a href="/terms">Terms</a> and <a href="/privacy">Privacy</a>{" "}
        pages.
      </p>
      {!mfaChallenge && !recovering && (
        <>
          {providers && (providers.google || providers.apple) && (
            <>
              <p className="orDivider">
                <span>or continue with</span>
              </p>
              <div className="socialButtons">
                {(["google", "apple"] as const)
                  .filter((p) => providers[p])
                  .map((p) => (
                    <a
                      key={p}
                      className="secondary full"
                      href={`/api/auth/oidc/${p}/start`}
                      onClick={(e) => {
                        const keep = document.querySelector<HTMLInputElement>(
                          'input[name="remember"]',
                        )?.checked;
                        e.currentTarget.href = `/api/auth/oidc/${p}/start${keep ? "?remember=1" : ""}`;
                      }}
                    >
                      {p === "google" ? (
                        <GoogleLogoIcon size={18} aria-hidden="true" />
                      ) : (
                        <AppleLogoIcon size={18} aria-hidden="true" />
                      )}
                      {p === "google" ? "Google" : "Apple"}
                    </a>
                  ))}
              </div>
              <small className="helpText">
                No account yet? Signing in this way sends an access request for
                your verified email; it does not create an account.
              </small>
            </>
          )}
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
  );
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
        {signInPanel}
      </AuthLayout>
    );
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
  const stripShown =
    section === "loads" &&
    !q &&
    !status &&
    !Object.keys(loadScope).length &&
    attention !== null;
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
  const recordTabs: { id: RecordTab; label: string; count?: number }[] = [
    { id: "timeline", label: "Timeline", count: timeline.length },
    { id: "route", label: "Route", count: selected?.stops?.length },
    { id: "check-ins", label: "Check-ins", count: selected?.check_ins?.length },
    {
      id: "documents",
      label: "Documents",
      count: selected?.documents?.filter((d) => d.status === "accepted").length,
    },
    {
      id: "exceptions",
      label: "Exceptions",
      count: selected?.exceptions?.filter((x) => x.status !== "resolved")
        .length,
    },
    ...(selectedRole !== "driver" && selectedRole !== undefined
      ? [{ id: "notes" as const, label: "Notes" }]
      : []),
    // Detention and TONU claims have no demo endpoints yet (ADR 0067).
    ...(!demo && selectedRole !== "driver" && selectedRole !== undefined
      ? [{ id: "claims" as const, label: "Claims" }]
      : []),
  ];
  const nextStage = selected
    ? stages[stages.indexOf(selected.stage) + 1]
    : undefined;
  const searchLabels: Partial<Record<WorkspaceSection, [string, string]>> = {
    loads: ["Search loads", "Search reference…"],
    exceptions: ["Search exceptions", "Search exceptions…"],
    inbox: ["Search conversations", "Search messages…"],
    contacts: ["Search contacts", "Search contacts…"],
    carriers: ["Search carriers", "Search carriers…"],
    prospects: ["Search prospects", "Search prospects…"],
    assistant: ["Search conversations", "Search chats…"],
    billing: ["Search invoices and loads", "Search invoices…"],
    reports: ["Search carriers", "Search carriers…"],
    organization: ["Search people", "Search people…"],
    audit: ["Search the audit log", "Search the log…"],
    fleet: ["Search the fleet", "Search fleet…"],
    documents: ["Search drafts", "Search drafts…"],
  };
  // Every page has a search. Pages with nothing of their own to filter
  // (account, organization, notifications) search loads and jump to them.
  const ownSearch = searchLabels[section];
  const pageSearch = {
    value: !ownSearch || section === "loads" ? q : (pageQ[section] ?? ""),
    onChange: (value: string) => {
      if (!ownSearch) {
        setSection("loads");
        filterChange({ q: value });
      } else if (section === "loads") filterChange({ q: value });
      else setPageQ((old) => ({ ...old, [section]: value }));
    },
    label: (ownSearch ?? searchLabels.loads!)[0],
    placeholder: (ownSearch ?? searchLabels.loads!)[1],
    inputRef: search,
  };
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
    <>
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
        onSearchLoads={(text) => {
          setSection("loads");
          filterChange({ q: text, carrier: "", status: "" });
        }}
        onLogout={logout}
        inbox={{
          folder: inboxFolder,
          counts: inboxCounts,
          onFolder: (f) => {
            setInboxFolder(f);
            setSection("inbox");
          },
        }}
      >
        <header className="topbar compact">
          {section === "loads" ? (
            <>
              <h1 className="srOnly">
                {driverOnly && !status ? "My loads" : queueTitle(status)}
              </h1>
            </>
          ) : (
            <h1 className="srOnly">{sectionTitles[section]}</h1>
          )}
        </header>
        <main id="main" className="workspace">
          {offline && (
            <ErrorAlert>
              Offline — this view may be stale. Reconnect, then refresh.
            </ErrorAlert>
          )}
          {!demo && !driverOnly && !selected && !creating && (
            <ApprovalsWaiting refreshKey={section} onAuthError={handleError} />
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
                trailing={controls}
              />
              {Object.keys(loadScope).length > 0 && (
                <div className="appliedFilters" role="status">
                  <span>
                    {loadScope.from && loadScope.to
                      ? `Pickup dates: ${loadScope.from} – ${loadScope.to} UTC`
                      : "Filtered pickup cohort"}
                    {loadScope.missing_pod === "true"
                      ? " · Delivered without accepted current POD"
                      : ""}
                  </span>
                  <button
                    className="secondary"
                    onClick={() => setLoadScope({})}
                  >
                    Clear report filters
                  </button>
                </div>
              )}
              {!driverOnly && (
                <LoadsViewBar
                  config={view}
                  onConfig={(patch) => setView((old) => ({ ...old, ...patch }))}
                  filters={{ status, carrier_id: carrier || null }}
                  carriers={context.carriers
                    .filter((c) => c.role !== "driver")
                    .map((c) => ({ id: c.id, name: c.name }))}
                  onFilters={(f) =>
                    filterChange({
                      status: f.status,
                      carrier: f.carrier_id ?? "",
                    })
                  }
                  onApply={(config, filters) => {
                    setView(config);
                    filterChange({
                      status: filters.status,
                      carrier: filters.carrier_id ?? "",
                    });
                  }}
                  onAuthError={handleError}
                />
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
                ) : view.layout === "table" && !driverOnly ? (
                  <TableView
                    loads={shownLoads}
                    config={view}
                    onConfig={(patch) =>
                      setView((old) => ({ ...old, ...patch }))
                    }
                    onOpen={open}
                    onAdd={createLoad}
                    disabled={busy || loading}
                  />
                ) : view.layout === "calendar" && !driverOnly ? (
                  <CalendarView
                    loads={shownLoads}
                    config={view}
                    onOpen={open}
                    disabled={busy || loading}
                  />
                ) : (
                  <Board
                    label="Load board"
                    noun="loads"
                    compact={view.compact}
                    lanes={stages.map((stage) => {
                      const items = shownLoads.filter((l) => l.stage === stage);
                      return {
                        id: stage,
                        label: stageLabels[stage],
                        items,
                        count: <Totals loads={items} />,
                      };
                    })}
                    itemKey={(load) => load.id}
                    renderCard={(load) => (
                      <LoadCard
                        load={load}
                        disabled={busy || loading}
                        onOpen={open}
                      />
                    )}
                    empty={
                      loading
                        ? "Loading…"
                        : queueFailed
                          ? "Couldn't load"
                          : "No loads here"
                    }
                    canDrag={() => !busy && !loading && !offline}
                    onMove={(id, stage) => void moveLoad(id, stage as Stage)}
                  />
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
                else if (source.kind === "document") {
                  setDraftToOpen(source.id);
                  setSection("documents");
                } else
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
          ) : section === "documents" ? (
            <DocumentsPage
              demo={demo}
              key={draftToOpen ?? "documents"}
              query={pageQ.documents ?? ""}
              offline={offline}
              openDraft={draftToOpen}
              onAuthError={handleError}
            />
          ) : section === "reports" ? (
            <Reports
              demo={demo}
              query={pageQ.reports ?? ""}
              scope={scopes.reports ?? {}}
              onScopeChange={(scope) =>
                setScopes((old) => ({ ...old, reports: scope }))
              }
              onOpenLoads={({
                carrier: c,
                status: st,
                attention: a,
                from,
                to,
                missing_pod,
              }) => {
                setSection("loads");
                filterChange({ carrier: c ?? "", status: st ?? "", q: "" });
                setLoadScope({
                  ...(from ? { from } : {}),
                  ...(to ? { to } : {}),
                  ...(missing_pod ? { missing_pod: "true" } : {}),
                });
                setAttentionKey(a ?? null);
              }}
              onOpenExceptions={(scope) => {
                setScopes((old) => ({ ...old, exceptions: scope }));
                setSection("exceptions");
              }}
              onOpenBilling={(scope) => {
                setScopes((old) => ({ ...old, billing: scope }));
                setSection("billing");
              }}
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
              folder={inboxFolder}
              onFolder={setInboxFolder}
              onCounts={setInboxCounts}
            />
          ) : section === "account" ? (
            <>
              {context?.mfa_required && (
                <p role="status" className="opsMeta">
                  {describe("MFA_REQUIRED")}
                </p>
              )}
              <AccountSettings
                onAuthError={handleError}
                onMfaEnabled={() => {
                  // Stay on Account so the recovery codes remain visible.
                  setSection("account");
                  api<Context>("me").then(setContext).catch(handleError);
                }}
              />
            </>
          ) : section === "organization" ? (
            <OrganizationSettings
              query={pageQ.organization ?? ""}
              context={context}
              onAuthError={handleError}
              onChanged={async () => setContext(await api<Context>("me"))}
            />
          ) : section === "fleet" ? (
            <FleetPage
              context={context}
              query={pageQ.fleet ?? ""}
              onClearQuery={() => setPageQ((old) => ({ ...old, fleet: "" }))}
              initialCarrier={carrier}
              onManageDrivers={setSetupCarrier}
              onAuthError={handleError}
              offline={offline}
            />
          ) : section === "audit" ? (
            <AuditLog
              query={pageQ.audit ?? ""}
              onClearQuery={() => setPageQ((old) => ({ ...old, audit: "" }))}
              onAuthError={handleError}
            />
          ) : section === "notifications" ? (
            <NotificationCenter
              isDispatcher={context.carriers.some(
                (c) => c.role === "dispatcher",
              )}
              driverOnly={driverOnly}
              onAuthError={handleError}
            />
          ) : section === "billing" &&
            scopes.billing?.basis === "issued" &&
            !invoiceTarget ? (
            <ReportInvoices
              scope={scopes.billing}
              onAuthError={handleError}
              onOpen={setInvoiceTarget}
            />
          ) : section === "billing" ? (
            <BillingWorkspace
              scope={scopes.billing ?? {}}
              query={pageQ.billing ?? ""}
              onClearQuery={() => setPageQ((old) => ({ ...old, billing: "" }))}
              context={context}
              offline={offline}
              onAuthError={handleError}
              invoiceId={invoiceTarget}
              onInvoiceChange={setInvoiceTarget}
              demo={demo}
            />
          ) : section === "exceptions" ? (
            <ExceptionQueue
              scope={scopes.exceptions ?? {}}
              onScopeChange={(scope) =>
                setScopes((old) => ({ ...old, exceptions: scope }))
              }
              query={pageQ.exceptions ?? ""}
              onClearQuery={() =>
                setPageQ((old) => ({ ...old, exceptions: "" }))
              }
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
              onAuthError={handleError}
              onOpenExceptions={() => setSection("exceptions")}
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
            <span>{updated && `Updated ${formatTime(updated)}`}</span>
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
            <section className="inspector record">
              <header className="recordHeader">
                <nav aria-label="Breadcrumb" className="crumbs recordCrumbs">
                  <ol>
                    <li>
                      <button
                        type="button"
                        className="textButton"
                        disabled={busy}
                        onClick={() => {
                          setSelected(null);
                          setError("");
                        }}
                      >
                        Loads
                      </button>
                      <span className="crumbSep" aria-hidden="true">
                        /
                      </span>
                    </li>
                    <li>
                      <span aria-current="page">{selected.reference}</span>
                    </li>
                  </ol>
                </nav>
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
              </header>
              <div className="recordBody">
                <aside className="recordFields" aria-label="Load fields">
                  <span className="recordAvatar" aria-hidden="true">
                    {selected.reference.charAt(0).toUpperCase()}
                  </span>
                  <h2 className="detailTitle">{selected.reference}</h2>
                  <small className="recordAdded">
                    Added {formatDate(selected.created_at)}
                  </small>
                  <span className={"badge " + selected.stage}>
                    <CircleIcon size={7} weight="fill" aria-hidden="true" />
                    {selected.cancelled_at
                      ? "Cancelled"
                      : stageLabels[selected.stage]}
                  </span>
                  <h3>Fields</h3>
                  <dl className="recordList">
                    <div>
                      <dt>Carrier</dt>
                      <dd className="detailCarrier">{selectedCarrier}</dd>
                    </div>
                    <div>
                      <dt>Agreed rate</dt>
                      <dd>{formatMoney(selected.amount_minor)}</dd>
                    </div>
                    <div>
                      <dt>Booking source</dt>
                      <dd>{selected.source}</dd>
                    </div>
                    <div>
                      <dt>Pickup</dt>
                      <dd>{selected.stops?.[0]?.address || "Not recorded"}</dd>
                    </div>
                    <div>
                      <dt>Delivery</dt>
                      <dd>
                        {selected.stops?.[selected.stops.length - 1]?.address ||
                          "Not recorded"}
                      </dd>
                    </div>
                  </dl>
                  <h3>Driver assignment</h3>
                  <div className="assignedDriver">
                    <TruckIcon size={18} aria-hidden="true" />
                    <span>
                      {selected.assignment?.name || "No driver assigned"}
                      {selected.assignment?.vehicle_label
                        ? ` · ${selected.assignment.vehicle_label}`
                        : ""}
                    </span>
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
                                // Only sent when the form offers vehicles; an empty
                                // choice clears it, an absent one keeps it.
                                vehicleId: f.has("vehicle")
                                  ? f.get("vehicle") || null
                                  : undefined,
                              });
                              setNotice("Driver assignment saved.");
                              setSelected(
                                await api<Load>("loads/" + selected.id),
                              );
                              await refreshAfterSave(
                                "Driver assignment saved.",
                              );
                            });
                          }}
                        >
                          <label>
                            <span className="srOnly">Authorized driver</span>
                            <select
                              name="driver"
                              required
                              defaultValue={
                                selected.assignment?.driver_id || ""
                              }
                            >
                              <option value="">Choose driver</option>
                              {context.drivers
                                .filter(
                                  (d) => d.carrier_id === selected.carrier_id,
                                )
                                .map((d) => (
                                  <option value={d.id} key={d.id}>
                                    {d.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <AssignVehicleSelect
                            key={selected.id + ":" + selected.version}
                            carrierId={selected.carrier_id}
                            current={selected.assignment?.vehicle_id || ""}
                            currentLabel={
                              selected.assignment?.vehicle_label || ""
                            }
                          />
                          <button
                            className="secondary"
                            disabled={busy || offline}
                          >
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
                                await api(
                                  "loads/" + selected.id + "/milestones",
                                  {
                                    version: selected.version,
                                    stage: nextStage,
                                  },
                                );
                                setNotice("Milestone recorded.");
                                setSelected(
                                  await api<Load>("loads/" + selected.id),
                                );
                                await refreshAfterSave("Milestone recorded.");
                              });
                            }}
                          >
                            {selected.assignment
                              ? "Record next milestone"
                              : "Choose a driver to continue"}
                            <ArrowRightIcon size={15} aria-hidden="true" />
                            {/* The stage it moves to, once it can move. */}
                            {selected.assignment && (
                              <small>{stageLabels[nextStage]}</small>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  {selectedRole === "driver" && (
                    <p className="helpText">
                      You can record manual check-ins for your assigned loads.
                      Contact dispatch for other changes.
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
                          load: {
                            id: selected.id,
                            reference: selected.reference,
                          },
                        });
                        setSelected(null);
                        setSection("inbox");
                      }}
                    >
                      Message about this load
                    </button>
                  )}
                </aside>
                <div className="recordMain">
                  <Tabs
                    label="Load sections"
                    idPrefix="record"
                    items={recordTabs}
                    value={recordTab}
                    onChange={setRecordTab}
                  />
                  <TabPanel
                    idPrefix="record"
                    value={recordTab}
                    className="recordPanel"
                  >
                    {recordTab === "timeline" && (
                      <>
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
                                <CircleIcon
                                  size={7}
                                  weight="fill"
                                  aria-hidden="true"
                                />
                                {eventLabels[e.type] || "Load updated"}
                                <small>
                                  {formatDateTimeLong(e.created_at)}
                                </small>
                              </p>
                            ))
                          ) : (
                            <p className="helpText">
                              Imported fictional fixture. No operational events
                              recorded yet.
                            </p>
                          )}
                        </div>
                      </>
                    )}
                    {recordTab === "route" && (
                      <>
                        <h3>Route & appointments</h3>
                        <StopList
                          load={selected}
                          canReport={!offline}
                          disabled={busy || offline}
                          onChanged={async (message) => {
                            setSelected(
                              await api<Load>("loads/" + selected.id),
                            );
                            await refreshAfterSave(message);
                          }}
                        />
                        <LoadChanges
                          load={selected}
                          canChange={
                            selectedRole !== "driver" &&
                            selectedRole !== undefined
                          }
                          disabled={busy || offline}
                          onAuthError={handleError}
                          onChanged={async (message) => {
                            setSelected(
                              await api<Load>("loads/" + selected.id),
                            );
                            await refreshAfterSave(message);
                          }}
                        />
                      </>
                    )}
                    {recordTab === "check-ins" && (
                      <>
                        <LoadCheckIns
                          key={selected.id}
                          load={selected}
                          busy={busy}
                          offline={offline}
                          userId={context.user.id}
                          role={selectedRole}
                          onAmended={async (message) => {
                            setSelected(
                              await api<Load>("loads/" + selected.id),
                            );
                            await refreshAfterSave(message);
                          }}
                          onRecord={async (input) => {
                            let result: "saved" | "retry" | "version-conflict" =
                              "retry";
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
                                    version: Math.max(
                                      current.version,
                                      response.version,
                                    ),
                                  },
                              );
                              setSelected(
                                await api<Load>("loads/" + selected.id),
                              );
                              await refreshAfterSave(
                                "Manual check-in recorded.",
                              );
                            });
                            return result;
                          }}
                        />
                      </>
                    )}
                    {recordTab === "documents" && (
                      <>
                        <h3>Documents</h3>
                        <p className="helpText">
                          Paperwork readiness is tracked separately from the
                          shipment milestone and from billing.
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
                            (selectedRole !== "driver" ||
                              driverUploadTypes.includes(type))
                          }
                          canReview={selectedRole === "dispatcher" && !offline}
                          downloads={!demo}
                          demo={demo}
                          disabled={busy || offline}
                          onChanged={async (message) => {
                            setSelected(
                              await api<Load>("loads/" + selected.id),
                            );
                            setNotice(message);
                          }}
                        />
                        {selectedRole !== "driver" &&
                          selectedRole !== undefined && (
                            <LoadDraft
                              key={"draft-" + selected.id}
                              loadId={selected.id}
                              offline={offline}
                              onAuthError={handleError}
                              onOpen={(id) => {
                                setDraftToOpen(id);
                                setSelected(null);
                                setSection("documents");
                              }}
                            />
                          )}
                      </>
                    )}
                    {recordTab === "exceptions" && (
                      <>
                        <LoadExceptions
                          load={selected}
                          role={selectedRole}
                          disabled={busy || offline}
                          onChanged={async (message) => {
                            setExceptionRevision((r) => r + 1);
                            setSelected(
                              await api<Load>("loads/" + selected.id),
                            );
                            setNotice(message);
                          }}
                        />
                      </>
                    )}
                    {recordTab === "claims" &&
                      !demo &&
                      selectedRole !== "driver" &&
                      selectedRole !== undefined && (
                        <LoadClaimsTab
                          key={"claims-" + selected.id}
                          loadId={selected.id}
                          offline={offline}
                          onAuthError={handleError}
                        />
                      )}
                    {recordTab === "notes" && (
                      <>
                        {selectedRole !== "driver" &&
                          selectedRole !== undefined && (
                            <LoadNotes
                              key={"notes-" + selected.id}
                              loadId={selected.id}
                              offline={offline}
                              onAuthError={handleError}
                            />
                          )}
                      </>
                    )}
                  </TabPanel>
                </div>
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
                      stops: ["pickup", ...extraStops, "delivery"].map(
                        (key) => {
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
                        },
                      ),
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
                    <DraftNote
                      draft={filled?.draft ?? null}
                      field="reference"
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
                  Stops run in order: the first is a pickup, the last a
                  delivery, and each appointment is no earlier than the one
                  before.
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
      {expired && (
        <ExpiredSignIn>
          <div className="authCard">
            <p className="inlineNotice" role="status">
              Your session expired. Sign in again to carry on: what you were
              working on is still here.
            </p>
            {signInPanel}
          </div>
        </ExpiredSignIn>
      )}
    </>
  );
}
