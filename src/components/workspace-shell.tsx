"use client";
import { useState } from "react";
import {
  StackIcon,
  TruckIcon,
  BuildingsIcon,
  MagnifyingGlassIcon,
  ArrowSquareOutIcon,
  SidebarSimpleIcon,
  PlusIcon,
  SignOutIcon,
  CircleIcon,
  XIcon,
  SquaresFourIcon,
  NavigationArrowIcon,
  CheckCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Modal } from "./modal";
import { stageLabels, type Context } from "@/lib/contracts";
export type WorkspaceSection = "loads" | "carriers" | "exceptions";
export const sectionTitles: Record<
  Exclude<WorkspaceSection, "loads">,
  string
> = {
  carriers: "Carriers",
  exceptions: "Exceptions",
};
export function Brand() {
  return (
    <span className="brand">
      <StackIcon size={21} weight="bold" aria-hidden="true" />
      relay<span className="brandPeriod">.</span>
    </span>
  );
}
const queues = [
  { value: "", label: "All loads", Icon: SquaresFourIcon },
  { value: "booked", label: "Ready to dispatch", Icon: CircleIcon },
  { value: "dispatched", label: "Dispatched", Icon: NavigationArrowIcon },
  { value: "picked-up", label: "In transit", Icon: TruckIcon },
  { value: "delivered", label: "Delivered", Icon: CheckCircleIcon },
];
export function WorkspaceShell({
  children,
  context,
  section,
  status,
  carrier,
  busy,
  offline,
  onSection,
  onQueue,
  onCarrier,
  onSearch,
  onCreate,
  onLogout,
}: {
  children: React.ReactNode;
  context: Context;
  section: WorkspaceSection;
  status: string;
  carrier: string;
  busy: boolean;
  offline: boolean;
  onSection: (section: WorkspaceSection) => void;
  onQueue: (status: string) => void;
  onCarrier: (id: string) => void;
  onSearch: () => void;
  onCreate: () => void;
  onLogout: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false),
    [mobileOpen, setMobileOpen] = useState(false);
  const driverOnly =
    context.carriers.length > 0 &&
    context.carriers.every((c) => c.role === "driver");
  function navigate(fn: () => void) {
    fn();
    setMobileOpen(false);
  }
  const navigation = (
    <>
      <div className="sidebarTitle">
        <span>{driverOnly ? "My workspace" : "Dispatch"}</span>
        <button
          className="iconButton desktopSidebarToggle"
          aria-label="Collapse sidebar"
          onClick={() => setCollapsed(true)}
        >
          <SidebarSimpleIcon size={17} aria-hidden="true" />
        </button>
        <button
          className="iconButton mobileClose"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        >
          <XIcon size={19} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebarActions">
        {context.carriers.some((c) => c.role !== "driver") && (
          <button disabled={busy || offline} onClick={() => navigate(onCreate)}>
            <PlusIcon size={17} aria-hidden="true" />
            New load
          </button>
        )}
        <button onClick={() => navigate(onSearch)}>
          <MagnifyingGlassIcon size={17} aria-hidden="true" />
          Search loads<kbd aria-hidden="true">⌘ K</kbd>
        </button>
      </div>
      <nav className="queueNav" aria-label="Dispatch queues">
        <p className="sidebarLabel">WORKSPACE</p>
        {queues
          .filter(
            (q) =>
              !driverOnly || ["", "picked-up", "delivered"].includes(q.value),
          )
          .map(({ value, label, Icon }) => (
            <button
              key={value}
              className={
                section === "loads" && status === value ? "active" : ""
              }
              disabled={busy}
              aria-current={
                section === "loads" && status === value ? "page" : undefined
              }
              onClick={() => navigate(() => onQueue(value))}
            >
              <Icon size={17} aria-hidden="true" />
              {driverOnly && value === "" ? "My loads" : label}
            </button>
          ))}
        {!driverOnly && (
          <button
            className={section === "carriers" ? "active" : ""}
            disabled={busy}
            aria-current={section === "carriers" ? "page" : undefined}
            onClick={() => navigate(() => onSection("carriers"))}
          >
            <BuildingsIcon size={17} aria-hidden="true" />
            Carriers
          </button>
        )}
        <button
          className={section === "exceptions" ? "active" : ""}
          disabled={busy}
          aria-current={section === "exceptions" ? "page" : undefined}
          onClick={() => navigate(() => onSection("exceptions"))}
        >
          <WarningIcon size={17} aria-hidden="true" />
          Exceptions
        </button>
      </nav>
      {!driverOnly && (
        <nav className="carrierNav" aria-label="Carrier scope">
          <p className="sidebarLabel">CARRIER SCOPE</p>
          <button
            className={!carrier ? "activeScope" : ""}
            aria-pressed={!carrier}
            disabled={busy}
            onClick={() => navigate(() => onCarrier(""))}
          >
            <CircleIcon size={8} weight="fill" aria-hidden="true" />
            All authorized carriers
          </button>
          {context.carriers.map((c) => (
            <button
              className={carrier === c.id ? "activeScope" : ""}
              key={c.id}
              aria-pressed={carrier === c.id}
              disabled={busy}
              onClick={() => navigate(() => onCarrier(c.id))}
              title={c.name}
            >
              <BuildingsIcon size={15} aria-hidden="true" />
              <span>{c.name}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="sidebarAccount">
        <span className="accountInitial" aria-hidden="true">
          {context.user.name
            .split(" ")
            .map((s) => s[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div>
          <strong>{context.user.name}</strong>
          <small>
            {driverOnly ? "Assigned loads only" : "Dispatch workspace"}
          </small>
        </div>
      </div>
    </>
  );
  return (
    <div className={"shell appShell" + (collapsed ? " sidebarCollapsed" : "")}>
      <a className="skipLink" href="#main">
        Skip to workspace
      </a>
      <nav className="iconRail" aria-label="Workspace navigation">
        <button
          className="railBrand"
          disabled={busy}
          aria-label="Relay load workspace"
          onClick={() => navigate(() => onQueue(""))}
        >
          <StackIcon size={24} weight="bold" aria-hidden="true" />
        </button>
        <button
          className="railNavToggle"
          aria-label="Open navigation"
          onClick={() => {
            if (window.matchMedia("(max-width: 1000px)").matches)
              setMobileOpen(true);
            else setCollapsed(!collapsed);
          }}
        >
          <SidebarSimpleIcon size={22} aria-hidden="true" />
        </button>
        <button aria-label="Search loads" onClick={onSearch}>
          <MagnifyingGlassIcon size={23} aria-hidden="true" />
        </button>
        <button
          className={section === "loads" ? "active" : ""}
          aria-label="Load workspace"
          disabled={busy}
          aria-current={section === "loads" ? "page" : undefined}
          onClick={() => navigate(() => onSection("loads"))}
        >
          <TruckIcon size={23} aria-hidden="true" />
        </button>
        {!driverOnly && (
          <button
            className={section === "carriers" ? "active" : ""}
            aria-label="Carrier directory"
            disabled={busy}
            aria-current={section === "carriers" ? "page" : undefined}
            onClick={() => navigate(() => onSection("carriers"))}
          >
            <BuildingsIcon size={23} aria-hidden="true" />
          </button>
        )}
        <button
          className={section === "exceptions" ? "active" : ""}
          aria-label="Exception queue"
          disabled={busy}
          aria-current={section === "exceptions" ? "page" : undefined}
          onClick={() => navigate(() => onSection("exceptions"))}
        >
          <WarningIcon size={23} aria-hidden="true" />
        </button>
        <div className="railSpacer" />
        <a
          href="/demo"
          aria-label="Open interactive demo"
          title="Interactive demo"
        >
          <ArrowSquareOutIcon size={21} aria-hidden="true" />
        </a>
        <button aria-label="Sign out" disabled={busy} onClick={onLogout}>
          <SignOutIcon size={22} aria-hidden="true" />
        </button>
      </nav>
      <aside className="contextSidebar">{navigation}</aside>
      <div className="mainPane">{children}</div>
      {mobileOpen && (
        <Modal
          label="Workspace navigation"
          onClose={() => setMobileOpen(false)}
        >
          <aside className="navigationSheet">{navigation}</aside>
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
