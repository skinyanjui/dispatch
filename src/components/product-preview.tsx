"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { Board } from "@/components/board";
import { LoadCard } from "@/components/load-card";
import { AttentionStrip } from "@/components/attention-strip";
import { DocumentsPage } from "@/components/documents-page";
import { LoadsViewBar } from "@/components/loads-view-bar";
import {
  CalendarView,
  TableView,
  Totals,
  defaultView,
  type ViewConfig,
} from "@/components/loads-views";
import { Brand, QueueTabs, workspacePages } from "@/components/workspace-shell";
import { ApiContext } from "@/lib/client-api";
import { createDemoApi } from "@/lib/demo-api";
import { sectionAllowed } from "@/lib/routes";
import { stageLabels, stages, type Context, type Load } from "@/lib/contracts";
import type { AttentionKey } from "@/lib/attention";

/**
 * The workspace as it looks, drawn with the app's own screens: the board
 * cards, queue strip, attention bar, table, calendar and Documents page are
 * the real components, fed by the interactive demo's fictional data (kept in
 * memory, never the demo's saved state). Nothing here can drift from the
 * product, and nothing in it is live data or can be operated.
 */
const tabs = [
  {
    id: "board",
    label: "Board",
    text: "Every load in its stage, with what is next, who has it and what needs attention.",
  },
  {
    id: "table",
    label: "Table",
    text: "Sort, group and hide columns, then save the view for yourself or your organization.",
  },
  {
    id: "calendar",
    label: "Calendar",
    text: "See appointments across the month.",
  },
  {
    id: "documents",
    label: "Documents",
    text: "Templates fill into drafts a person reviews.",
  },
] as const;
type Tab = (typeof tabs)[number]["id"];
type Attention = {
  counts: Record<AttentionKey, number>;
  total: number;
  truncated: boolean;
};
const nothing = () => undefined;

function PreviewSidebar({
  context,
  section,
}: {
  context: Context;
  section: "loads" | "documents";
}) {
  return (
    <aside className="sidebarDock">
      <div className="sidebar">
        <div className="sidebarTop">
          <Brand />
        </div>
        <label className="sidebarSearch">
          <MagnifyingGlassIcon size={16} aria-hidden="true" />
          <input
            type="search"
            readOnly
            tabIndex={-1}
            aria-label="Search"
            placeholder={
              section === "loads" ? "Search reference..." : "Search drafts..."
            }
          />
        </label>
        <div className="sidebarActions">
          <button type="button" tabIndex={-1} className="sidebarItem newLoad">
            <PlusIcon size={16} weight="bold" aria-hidden="true" />
            <span className="navLabel">New load</span>
          </button>
        </div>
        <nav className="sidebarPages" aria-label="Preview navigation">
          {workspacePages
            .filter((p) => sectionAllowed(p.key, context))
            .map(({ key, label, Icon }) => (
              <div key={key} className="sidebarGroup">
                <div className="sidebarRow">
                  <button
                    type="button"
                    tabIndex={-1}
                    className={
                      "sidebarItem" + (section === key ? " active" : "")
                    }
                  >
                    <Icon
                      size={16}
                      weight={section === key ? "fill" : "regular"}
                      aria-hidden="true"
                    />
                    <span className="navLabel">{label}</span>
                  </button>
                </div>
                {key === "loads" && section === "loads" && (
                  <div className="sidebarChildren">
                    <nav aria-label="Carrier scope">
                      <button
                        type="button"
                        tabIndex={-1}
                        className="sidebarSub active"
                      >
                        All authorized carriers
                      </button>
                      {context.carriers.map((c) => (
                        <button
                          type="button"
                          tabIndex={-1}
                          key={c.id}
                          className="sidebarSub"
                        >
                          {c.name}
                        </button>
                      ))}
                    </nav>
                  </div>
                )}
              </div>
            ))}
        </nav>
        <div className="sidebarSpacer" />
        <div className="accountArea">
          <button type="button" tabIndex={-1} className="accountButton">
            <span className="accountInitial" aria-hidden="true">
              {context.user.name
                .split(" ")
                .map((s) => s[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span className="accountName">
              <strong>{context.user.name}</strong>
              <small>Dispatch workspace</small>
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}

/** The drawing is laid out as a 1280px-wide window and shrunk to fit (the
 *  stage sizes are in marketing.css), so its cards are as wide as they are in
 *  the app and their text fills a line before wrapping. Below 900px wide it is
 *  laid out naturally, as on a phone. */
const stageWidth = 1280,
  scaleFrom = 900;
function useStageScale() {
  return useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const update = () => {
      if (el.clientWidth >= scaleFrom) {
        el.style.setProperty(
          "--pv-scale",
          String(Math.min(1, el.clientWidth / stageWidth)),
        );
        el.dataset.scaled = "true";
      } else {
        el.style.removeProperty("--pv-scale");
        delete el.dataset.scaled;
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
}

export function ProductPreview() {
  const watch = useStageScale();
  const [tab, setTab] = useState<Tab>("board");
  const [adapter] = useState(() => createDemoApi({ persist: false }));
  const [data, setData] = useState<{
    context: Context;
    loads: Load[];
    attention: Attention;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([
      adapter.api<Context>("me"),
      adapter.api<{ loads: Load[] }>("loads"),
      adapter.api<Attention>("loads/attention"),
    ])
      .then(([context, list, attention]) => {
        if (live) setData({ context, loads: list.loads, attention });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [adapter]);
  const view: ViewConfig = useMemo(
    () => ({
      ...defaultView,
      layout: tab === "table" || tab === "calendar" ? tab : "board",
    }),
    [tab],
  );
  const section = tab === "documents" ? "documents" : "loads";
  return (
    <div className="preview">
      <Tabs
        label="Product views"
        idPrefix="pv"
        className="previewTabs"
        items={tabs}
        value={tab}
        onChange={setTab}
      />
      <p className="previewText">{tabs.find((t) => t.id === tab)!.text}</p>
      <TabPanel idPrefix="pv" value={tab} className="previewFrame">
        {failed || !data ? (
          <p className="previewLoading" role="status">
            {failed
              ? "The sample workspace could not be drawn."
              : "Loading the sample workspace…"}
          </p>
        ) : (
          // Decorative: the real screens, but nothing in the drawing can be
          // focused or used (inert), and it is hidden from assistive tech.
          <ApiContext.Provider value={adapter.api}>
            <div className="previewViewport" ref={watch}>
              <div className="previewStage">
                <div
                  className="shell appShell previewShell"
                  inert
                  aria-hidden="true"
                >
                  <PreviewSidebar context={data.context} section={section} />
                  <div className="mainPane">
                    <div className="workspace">
                      {tab === "documents" ? (
                        <DocumentsPage
                          offline={false}
                          demo
                          onAuthError={nothing}
                        />
                      ) : (
                        <>
                          <QueueTabs
                            status=""
                            driverOnly={false}
                            busy={false}
                            onQueue={nothing}
                            trailing={
                              <div className="toolbar">
                                <div className="toolbarLeft">
                                  <span className="toolbarMeta">
                                    {data.loads.length} loads
                                  </span>
                                </div>
                              </div>
                            }
                          />
                          <LoadsViewBar
                            config={view}
                            onConfig={nothing}
                            filters={{ status: "", carrier_id: null }}
                            carriers={data.context.carriers}
                            onFilters={nothing}
                            onApply={nothing}
                            onAuthError={nothing}
                          />
                          <AttentionStrip
                            counts={data.attention.counts}
                            total={data.attention.total}
                            truncated={data.attention.truncated}
                            active={null}
                            onToggle={nothing}
                          />
                          <section
                            className="loadSurface"
                            aria-label="Load workspace"
                          >
                            {tab === "table" ? (
                              <TableView
                                loads={data.loads}
                                config={view}
                                onConfig={nothing}
                                onOpen={nothing}
                                disabled={false}
                              />
                            ) : tab === "calendar" ? (
                              <CalendarView
                                loads={data.loads}
                                config={view}
                                onOpen={nothing}
                                disabled={false}
                              />
                            ) : (
                              <Board
                                label="Load board"
                                noun="loads"
                                lanes={stages.map((stage) => {
                                  const items = data.loads.filter(
                                    (l) => l.stage === stage,
                                  );
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
                                    disabled={false}
                                    onOpen={nothing}
                                  />
                                )}
                                empty="No loads here"
                              />
                            )}
                          </section>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ApiContext.Provider>
        )}
      </TabPanel>
      <small className="previewNote">
        The real screens with fictional sample data, not live data.
      </small>
    </div>
  );
}
