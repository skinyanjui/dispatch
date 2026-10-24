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
  SteeringWheelIcon,
  CaretDownIcon,
} from "@phosphor-icons/react";
import { Modal } from "./modal";
import { folderCount, inboxFolders, type InboxCounts } from "./inbox";
import { stageLabels, type Context } from "@/lib/contracts";
import { sectionAllowed, type WorkspaceSection } from "@/lib/routes";
import { browserStore, mostUsedSection } from "@/lib/most-used";
export type { WorkspaceSection };
export const sectionTitles: Record<
  Exclude<WorkspaceSection, "loads">,
  string
> = {
  carriers: "Carriers",
  fleet: "Fleet",
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
      {/* On phones the strip scrolls sideways. While busy every tab is
          disabled, and a scroll region with nothing focusable in it cannot be
          scrolled from the keyboard, so the strip itself takes focus then. */}
      <nav
        className="queueTabs"
        aria-label="Dispatch queues"
        tabIndex={busy ? 0 : undefined}
      >
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
                className={"queueDot " + (value || "all")}
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
/** Every page in the sidebar, in order. The home-page preview draws its sidebar
 *  from this list, so the two cannot disagree about which pages exist. */
export const workspacePages = [
  // Prospects are the dispatch company's own sales records (ADR 0030).
  { key: "loads", label: "Loads", Icon: TruckIcon },
  { key: "exceptions", label: "Exceptions", Icon: WarningIcon },
  { key: "inbox", label: "Inbox", Icon: TrayIcon },
  { key: "contacts", label: "Contacts", Icon: AddressBookIcon },
  { key: "carriers", label: "Carriers", Icon: BuildingsIcon },
  { key: "fleet", label: "Fleet", Icon: SteeringWheelIcon },
  { key: "prospects", label: "Prospects", Icon: HandshakeIcon },
  { key: "assistant", label: "Assistant", Icon: SparkleIcon },
  { key: "documents", label: "Documents", Icon: FileTextIcon },
  { key: "billing", label: "Billing", Icon: ReceiptIcon },
  { key: "reports", label: "Reports", Icon: ChartBarIcon },
] as const satisfies readonly {
  key: WorkspaceSection;
  label: string;
  Icon: typeof TruckIcon;
}[];
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
  inbox,
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
  /** The Inbox's folders, listed under Inbox while it is open. */
  inbox?: {
    folder: string;
    counts: InboxCounts | null;
    onFolder: (folder: string) => void;
  };
}) {
  const [collapsed, setCollapsed] = useState(false),
    [mobileOpen, setMobileOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [allCarriers, setAllCarriers] = useState(false),
    [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({}),
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
  const initials = context.user.name
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("");
  const pages = workspacePages.map(({ key, label, Icon }) => ({
    key,
    label,
    Icon,
    show: sectionAllowed(key, context),
  }));
  // The logo goes to the page this person uses most (counted in this browser),
  // Loads until there is a habit to follow.
  const homeSection = mostUsedSection(
    browserStore(),
    context.user.id ?? context.user.email ?? "demo",
    (k) => sectionAllowed(k, context),
  );
  const homeLabel =
    homeSection === "loads" ? "Loads" : sectionTitles[homeSection];
  const brandHome = (after?: () => void) => (
    <button
      type="button"
      className="brandHome"
      aria-label={`Relay, go to ${homeLabel}`}
      title={`Go to ${homeLabel}`}
      disabled={busy}
      onClick={() => {
        after?.();
        go(() =>
          homeSection === "loads" ? onQueue("") : onSection(homeSection),
        );
      }}
    >
      <Brand />
    </button>
  );
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

  /** A page's own views, nested under it in the sidebar while it is open. */
  const subItems = (
    key: WorkspaceSection,
  ): { name: string; node: ReactNode } | null => {
    if (key === "loads" && !driverOnly && context.carriers.length > 1)
      return {
        name: "Carrier list",
        node: (
          <nav aria-label="Carrier scope">
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
                className={"sidebarSub" + (carrier === c.id ? " active" : "")}
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
        ),
      };
    if (key === "inbox" && inbox)
      return {
        name: "Folder list",
        node: (
          <div role="group" aria-label="Inbox folders">
            {Object.keys(inboxFolders).map((f) => {
              const count = folderCount(f, inbox.counts);
              const isBox = f === "archived" || f === "trash";
              return (
                <button
                  key={f}
                  className={
                    "sidebarSub" +
                    (inbox.folder === f ? " active" : "") +
                    (f === "archived" ? " firstBox" : "")
                  }
                  aria-pressed={inbox.folder === f}
                  disabled={busy}
                  onClick={() => go(() => inbox.onFolder(f))}
                >
                  <span>{inboxFolders[f]}</span>
                  {count > 0 && (
                    <span
                      className={"subCount" + (isBox ? " quiet" : "")}
                      aria-label={`${count} ${isBox ? "conversations" : "unread"}`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ),
      };
    return null;
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
              {brandHome()}
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
            .map(({ key, label, Icon }) => {
              const children =
                compact || section !== key ? null : subItems(key);
              const open = Boolean(children) && !closedGroups[key];
              return (
                <div key={key} className="sidebarGroup">
                  <div className="sidebarRow">
                    <button
                      className={
                        "sidebarItem" + (section === key ? " active" : "")
                      }
                      disabled={busy}
                      title={label}
                      aria-current={section === key ? "page" : undefined}
                      onClick={() =>
                        go(() =>
                          key === "loads" ? onQueue(status) : onSection(key),
                        )
                      }
                    >
                      <Icon
                        {...icon}
                        weight={section === key ? "fill" : "regular"}
                      />
                      <span className="navLabel">{label}</span>
                      {key === "inbox" && unread > 0 && (
                        <span className="navBadge">
                          {unread > 99 ? "99+" : unread}
                          <span className="srOnly"> unread</span>
                        </span>
                      )}
                    </button>
                    {children && (
                      <button
                        type="button"
                        className={"sidebarToggle" + (open ? " open" : "")}
                        aria-expanded={open}
                        aria-controls={"sidebar-sub-" + key}
                        aria-label={children.name}
                        title={
                          (open ? "Hide " : "Show ") +
                          children.name.toLowerCase()
                        }
                        onClick={() =>
                          setClosedGroups((g) => ({ ...g, [key]: open }))
                        }
                      >
                        <CaretDownIcon size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {open && (
                    <div id={"sidebar-sub-" + key} className="sidebarChildren">
                      {children!.node}
                    </div>
                  )}
                </div>
              );
            })}
        </nav>
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
        {brandHome()}
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
