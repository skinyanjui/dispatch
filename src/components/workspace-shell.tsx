"use client";
import { CommandPalette, type Command } from "@/components/command-palette";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  StackIcon,
  TruckIcon,
  BuildingsIcon,
  MagnifyingGlassIcon,
  ArrowSquareOutIcon,
  SidebarSimpleIcon,
  PlusIcon,
  SignOutIcon,
  XIcon,
  WarningIcon,
  ReceiptIcon,
  BellIcon,
  UserCircleIcon,
  GearSixIcon,
  ListIcon,
  CaretUpDownIcon,
  AddressBookIcon,
  FileTextIcon,
  HandshakeIcon,
  SparkleIcon,
  TrayIcon,
  ChartBarIcon,
  ClipboardTextIcon,
} from "@phosphor-icons/react";
import { Modal } from "./modal";
import { stageLabels, type Context } from "@/lib/contracts";
import { sectionAllowed, type WorkspaceSection } from "@/lib/routes";
export type { WorkspaceSection };
export const sectionTitles: Record<
  Exclude<WorkspaceSection, "loads">,
  string
> = {
  carriers: "Carriers",
  exceptions: "Exceptions",
  billing: "Billing",
  notifications: "Notifications",
  account: "Account",
  organization: "Organization",
  audit: "Audit log",
  documents: "Documents",
  contacts: "Contacts",
  prospects: "Prospects",
  assistant: "Assistant",
  inbox: "Inbox",
  reports: "Reports",
};
export function Brand() {
  return (
    <span className="brand">
      <StackIcon size={20} weight="bold" aria-hidden="true" />
      relay<span className="brandPeriod">.</span>
    </span>
  );
}
export const queues = [
  { value: "", label: "All loads" },
  { value: "booked", label: "Ready to dispatch" },
  { value: "dispatched", label: "Dispatched" },
  { value: "picked-up", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];
const dotColors: Record<string, string> = {
  "": "var(--accent)",
  booked: "#5b6b7a",
  dispatched: "#8b5cf6",
  "picked-up": "#f59e0b",
  delivered: "#10b981",
  cancelled: "#ef4444",
};
/** The load queues, as a row above the board with a coloured dot each. */
export function QueueTabs({
  status,
  driverOnly,
  busy,
  onQueue,
  trailing,
}: {
  status: string;
  driverOnly: boolean;
  busy: boolean;
  onQueue: (status: string) => void;
  /** Sits at the end of the same row as the pills (count, refresh). */
  trailing?: ReactNode;
}) {
  return (
    <div className="queueRow">
      <nav className="queueTabs" aria-label="Dispatch queues">
        {queues
          .filter(
            (q) =>
              !driverOnly ||
              ["", "picked-up", "delivered", "cancelled"].includes(q.value),
          )
          .map(({ value, label }) => (
            <button
              key={value}
              className={"queueTab" + (status === value ? " active" : "")}
              disabled={busy}
              aria-current={status === value ? "page" : undefined}
              onClick={() => onQueue(value)}
            >
              <span
                className="queueDot"
                style={{ background: dotColors[value] }}
                aria-hidden="true"
              />
              {driverOnly && value === "" ? "My loads" : label}
            </button>
          ))}
      </nav>
      {trailing}
    </div>
  );
}
const icon = { size: 16, "aria-hidden": true } as const;
const collapseKey = "relay-sidebar-collapsed";

/**
 * One sidebar, modelled on Claude's: primary actions, each page exactly once,
 * contextual sub-lists only for the current page, and personal settings
 * behind the account menu. Collapsing keeps the same items as icons.
 */
export function WorkspaceShell({
  children,
  context,
  section,
  status,
  carrier,
  busy,
  offline,
  unread = 0,
  onSection,
  onQueue,
  onCarrier,
  search,
  onCreate,
  onLogout,
  onSearchLoads,
}: {
  children: React.ReactNode;
  context: Context;
  section: WorkspaceSection;
  status: string;
  carrier: string;
  busy: boolean;
  offline: boolean;
  unread?: number;
  onSection: (section: WorkspaceSection) => void;
  onQueue: (status: string) => void;
  onCarrier: (id: string) => void;
  /** The one search box, at the top of the sidebar; it filters this page. */
  search: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    placeholder: string;
    inputRef: RefObject<HTMLInputElement | null>;
  } | null;
  onCreate: () => void;
  onLogout: () => void;
  /** Jump to Loads with this search text. */
  onSearchLoads?: (text: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false),
    [mobileOpen, setMobileOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [allCarriers, setAllCarriers] = useState(false),
    [palette, setPalette] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Remembered per browser; storage may be unavailable.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(collapseKey) === "true");
    } catch {
      /* default expanded */
    }
  }, []);
  useEffect(() => {
    // Ctrl or ⌘ + Shift + K opens the command menu (Ctrl+K stays search).
    const open = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !menuRef.current?.contains(e.target as Node)
      )
        setMenuOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [menuOpen]);
  function toggle(next: boolean) {
    setCollapsed(next);
    try {
      localStorage.setItem(collapseKey, String(next));
    } catch {
      /* not persisted */
    }
  }
  const driverOnly =
    context.carriers.length > 0 &&
    context.carriers.every((c) => c.role === "driver");
  const isAdmin = (context.organizations || []).some((o) => o.role);
  // Prospects are the dispatch company's own sales records (ADR 0030).
  const orgStaff =
    isAdmin || context.carriers.some((c) => c.role === "dispatcher");
  const initials = context.user.name
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("");
  const pages: {
    key: WorkspaceSection;
    label: string;
    Icon: typeof TruckIcon;
    show: boolean;
  }[] = (
    [
      ["loads", "Loads", TruckIcon],
      ["exceptions", "Exceptions", WarningIcon],
      ["inbox", "Inbox", TrayIcon],
      ["contacts", "Contacts", AddressBookIcon],
      ["carriers", "Carriers", BuildingsIcon],
      // Prospects are the dispatch company's own sales records (ADR 0030).
      ["prospects", "Prospects", HandshakeIcon],
      ["assistant", "Assistant", SparkleIcon],
      ["documents", "Documents", FileTextIcon],
      ["billing", "Billing", ReceiptIcon],
      ["reports", "Reports", ChartBarIcon],
    ] as const
  ).map(([key, label, Icon]) => ({
    key,
    label,
    Icon,
    show: sectionAllowed(key, context),
  }));
  const commands: Command[] = [
    ...pages
      .filter((p) => p.show)
      .map((p) => ({
        id: "go-" + p.key,
        group: "Go to",
        label: p.label,
        run: () => onSection(p.key),
      })),
    ...(
      [
        ["account", "Account", true],
        ["organization", "Organization", isAdmin],
        ["audit", "Audit log", isAdmin],
        ["notifications", "Notifications", true],
      ] as const
    )
      .filter(([, , show]) => show)
      .map(([key, label]) => ({
        id: "go-" + key,
        group: "Go to",
        label,
        run: () => onSection(key),
      })),
    ...(driverOnly
      ? []
      : [
          {
            id: "new-load",
            group: "Create",
            label: "New load",
            run: onCreate,
          },
        ]),
    ...queues
      .filter(
        (q) =>
          !driverOnly ||
          ["", "picked-up", "delivered", "cancelled"].includes(q.value),
      )
      .map((q) => ({
        id: "queue-" + (q.value || "all"),
        group: "Loads",
        label: q.label,
        hint: "Open this queue",
        run: () => onQueue(q.value),
      })),
    ...(driverOnly
      ? []
      : context.carriers
          .filter((c) => c.role !== "driver")
          .map((c) => ({
            id: "carrier-" + c.id,
            group: "Carriers",
            label: c.name,
            hint: "View loads",
            run: () => onCarrier(c.id),
          }))),
  ];
  const go = (fn: () => void) => {
    fn();
    setMobileOpen(false);
    setMenuOpen(false);
  };

  const sidebar = (sheet: boolean) => {
    const compact = collapsed && !sheet;
    return (
      <div className={"sidebar" + (compact ? " compact" : "")}>
        <div className="sidebarTop">
          {compact ? (
            <button
              className="sidebarIcon"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              onClick={() => toggle(false)}
            >
              <SidebarSimpleIcon {...icon} />
            </button>
          ) : (
            <>
              <Brand />
              <button
                className="sidebarIcon"
                aria-label={sheet ? "Close navigation" : "Collapse sidebar"}
                title={sheet ? "Close navigation" : "Collapse sidebar"}
                onClick={() => (sheet ? setMobileOpen(false) : toggle(true))}
              >
                {sheet ? <XIcon {...icon} /> : <SidebarSimpleIcon {...icon} />}
              </button>
            </>
          )}
        </div>
        {search &&
          (compact ? (
            <button
              className="sidebarIcon sidebarSearchIcon"
              aria-label={search.label}
              title={`${search.label} (⌘K)`}
              onClick={() => {
                toggle(false);
                setTimeout(() => search.inputRef.current?.focus(), 50);
              }}
            >
              <MagnifyingGlassIcon {...icon} />
            </button>
          ) : (
            <label className="sidebarSearch">
              <MagnifyingGlassIcon {...icon} />
              <span className="srOnly">{search.label}</span>
              <input
                ref={sheet ? undefined : search.inputRef}
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder}
                maxLength={100}
              />
            </label>
          ))}
        <div className="sidebarActions">
          {!driverOnly && (
            <button
              className="sidebarItem newLoad"
              disabled={busy || offline}
              title="New load"
              onClick={() => go(onCreate)}
            >
              <PlusIcon {...icon} weight="bold" />
              <span className="navLabel">New load</span>
            </button>
          )}
        </div>
        <nav className="sidebarPages" aria-label="Workspace navigation">
          {pages
            .filter((p) => p.show)
            .map(({ key, label, Icon }) => (
              <button
                key={key}
                className={"sidebarItem" + (section === key ? " active" : "")}
                disabled={busy}
                title={label}
                aria-current={section === key ? "page" : undefined}
                onClick={() =>
                  go(() => (key === "loads" ? onQueue(status) : onSection(key)))
                }
              >
                <Icon {...icon} weight={section === key ? "fill" : "regular"} />
                <span className="navLabel">{label}</span>
                {key === "inbox" && unread > 0 && (
                  <span className="navBadge">
                    {unread > 99 ? "99+" : unread}
                    <span className="srOnly"> unread</span>
                  </span>
                )}
              </button>
            ))}
        </nav>
        {!compact && section === "loads" && (
          <div className="sidebarContext">
            {!driverOnly && context.carriers.length > 1 && (
              <nav aria-label="Carrier scope">
                <p className="sidebarLabel">Carriers</p>
                <button
                  className={"sidebarSub" + (!carrier ? " active" : "")}
                  aria-pressed={!carrier}
                  disabled={busy}
                  onClick={() => go(() => onCarrier(""))}
                >
                  All authorized carriers
                </button>
                {(allCarriers
                  ? context.carriers
                  : context.carriers.slice(0, 6)
                ).map((c) => (
                  <button
                    className={
                      "sidebarSub" + (carrier === c.id ? " active" : "")
                    }
                    key={c.id}
                    aria-pressed={carrier === c.id}
                    disabled={busy}
                    title={c.name}
                    onClick={() => go(() => onCarrier(c.id))}
                  >
                    {c.name}
                  </button>
                ))}
                {context.carriers.length > 6 && (
                  <button
                    className="sidebarSub sidebarMore"
                    aria-expanded={allCarriers}
                    onClick={() => setAllCarriers(!allCarriers)}
                  >
                    {allCarriers
                      ? "Show fewer"
                      : `Show all ${context.carriers.length}`}
                  </button>
                )}
              </nav>
            )}
          </div>
        )}
        <div className="sidebarSpacer" />
        <div className="accountArea" ref={sheet ? undefined : menuRef}>
          {menuOpen && !sheet && (
            <div className="accountMenu" aria-label="Account options">
              <p className="accountMenuEmail">
                {context.user.email || context.user.name}
              </p>
              <button onClick={() => go(() => onSection("account"))}>
                <UserCircleIcon {...icon} />
                Account
              </button>
              {isAdmin && (
                <button onClick={() => go(() => onSection("organization"))}>
                  <GearSixIcon {...icon} />
                  Organization
                </button>
              )}
              {isAdmin && (
                <button onClick={() => go(() => onSection("audit"))}>
                  <ClipboardTextIcon {...icon} />
                  Audit log
                </button>
              )}
              <button onClick={() => go(() => onSection("notifications"))}>
                <BellIcon {...icon} />
                Notifications
              </button>
              <a href="/demo">
                <ArrowSquareOutIcon {...icon} />
                Interactive demo
              </a>
              <hr />
              <button disabled={busy} onClick={() => go(onLogout)}>
                <SignOutIcon {...icon} />
                Sign out
              </button>
            </div>
          )}
          {sheet ? (
            <div className="sheetAccount">
              {[
                {
                  key: "account",
                  label: "Account",
                  Icon: UserCircleIcon,
                  show: true,
                },
                {
                  key: "organization",
                  label: "Organization",
                  Icon: GearSixIcon,
                  show: isAdmin,
                },
                {
                  key: "audit",
                  label: "Audit log",
                  Icon: ClipboardTextIcon,
                  show: isAdmin,
                },
                {
                  key: "notifications",
                  label: "Notifications",
                  Icon: BellIcon,
                  show: true,
                },
              ]
                .filter((i) => i.show)
                .map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    className={
                      "sidebarItem" + (section === key ? " active" : "")
                    }
                    onClick={() => go(() => onSection(key as WorkspaceSection))}
                  >
                    <Icon {...icon} />
                    <span className="navLabel">{label}</span>
                  </button>
                ))}
              <button
                className="sidebarItem"
                disabled={busy}
                onClick={() => go(onLogout)}
              >
                <SignOutIcon {...icon} />
                <span className="navLabel">Sign out</span>
              </button>
            </div>
          ) : (
            <button
              className="accountButton"
              aria-label="Account menu"
              aria-expanded={menuOpen}
              title={context.user.name}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span className="accountInitial" aria-hidden="true">
                {initials}
              </span>
              {!compact && (
                <>
                  <span className="accountName">
                    <strong>{context.user.name}</strong>
                    <small>
                      {driverOnly ? "Driver" : "Dispatch workspace"}
                    </small>
                  </span>
                  <CaretUpDownIcon size={14} aria-hidden="true" />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={"shell appShell" + (collapsed ? " sidebarCollapsed" : "")}>
      {palette && (
        <CommandPalette
          commands={commands}
          searchLoads={(text) => onSearchLoads?.(text)}
          onClose={() => setPalette(false)}
        />
      )}
      <a className="skipLink" href="#main">
        Skip to workspace
      </a>
      <aside className="sidebarDock">{sidebar(false)}</aside>
      <div className="mobileBar">
        <button
          className="sidebarIcon"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <ListIcon size={18} aria-hidden="true" />
        </button>
        <Brand />
        {!driverOnly && (
          <button
            className="sidebarIcon mobileCreate"
            aria-label="New load"
            disabled={busy || offline}
            onClick={onCreate}
          >
            <PlusIcon size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mainPane">{children}</div>
      {mobileOpen && (
        <Modal
          label="Workspace navigation"
          onClose={() => setMobileOpen(false)}
        >
          <aside className="navigationSheet">{sidebar(true)}</aside>
        </Modal>
      )}
    </div>
  );
}
export function queueTitle(status: string) {
  return status === "booked"
    ? "Ready to dispatch"
    : stageLabels[status as keyof typeof stageLabels] || "All loads";
}
