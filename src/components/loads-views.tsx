"use client";
import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretDownIcon,
} from "@phosphor-icons/react";
import { formatMoney } from "@/lib/entry";
import { stageLabels, type Load } from "@/lib/contracts";
import { loadDocumentTypes } from "@/lib/compliance";

export type ViewField =
  | "carrier"
  | "stage"
  | "next"
  | "driver"
  | "docs"
  | "freight"
  | "created";
export type ViewConfig = {
  layout: "board" | "table" | "calendar";
  group_by: "none" | "stage" | "carrier";
  sort: { key: "reference" | ViewField; desc: boolean };
  hidden_fields: ViewField[];
  compact: boolean;
  calendar_field: "next" | "created";
};
export const defaultView: ViewConfig = {
  layout: "board",
  group_by: "none",
  sort: { key: "created", desc: true },
  hidden_fields: [],
  compact: false,
  calendar_field: "next",
};
export const fieldLabels: Record<ViewField, string> = {
  carrier: "Carrier",
  stage: "Stage",
  next: "Next appointment",
  driver: "Driver",
  docs: "Documents",
  freight: "Freight",
  created: "Created",
};
const allFields = Object.keys(fieldLabels) as ViewField[];

const sum = (loads: Load[]) =>
  formatMoney(
    loads.reduce((t, l) => t + BigInt(l.amount_minor), 0n).toString(),
  );
const dateOf = (l: Load, field: "next" | "created") =>
  field === "created" ? l.created_at : (l.summary?.next?.window_start ?? "");
const day = (iso: string) =>
  `${new Date(iso).getFullYear()}-${String(new Date(iso).getMonth() + 1).padStart(2, "0")}-${String(new Date(iso).getDate()).padStart(2, "0")}`;
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

function sortValue(l: Load, key: ViewConfig["sort"]["key"]): string | number {
  switch (key) {
    case "reference":
      return l.reference.toLowerCase();
    case "carrier":
      return (l.carrier_name ?? "").toLowerCase();
    case "stage":
      return Object.keys(stageLabels).indexOf(l.stage);
    case "next":
      return l.summary?.next?.window_start ?? "9999";
    case "driver":
      return (l.summary?.driver_name ?? "~").toLowerCase();
    case "docs":
      return l.summary?.docs.accepted ?? 0;
    case "freight":
      return Number(l.amount_minor);
    default:
      return l.created_at;
  }
}
export function sortLoads(loads: Load[], sort: ViewConfig["sort"]) {
  return [...loads].sort((a, b) => {
    const x = sortValue(a, sort.key),
      y = sortValue(b, sort.key);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return sort.desc ? -order : order;
  });
}

/** Aggregates shown at the top of a board column or table group. */
export function Totals({ loads }: { loads: Load[] }) {
  return (
    <span className="groupTotals">
      {loads.length} · {sum(loads)}
    </span>
  );
}

export function TableView({
  loads,
  config,
  onConfig,
  onOpen,
  disabled,
}: {
  loads: Load[];
  config: ViewConfig;
  onConfig: (patch: Partial<ViewConfig>) => void;
  onOpen: (id: string) => void;
  disabled: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const show = (f: ViewField) => !config.hidden_fields.includes(f);
  const sorted = useMemo(() => sortLoads(loads, config.sort), [loads, config]);
  const groups = useMemo(() => {
    if (config.group_by === "none")
      return [{ key: "", label: "", items: sorted }];
    const map = new Map<string, Load[]>();
    for (const l of sorted) {
      const k = config.group_by === "stage" ? l.stage : l.carrier_id;
      map.set(k, [...(map.get(k) ?? []), l]);
    }
    const label = (k: string, first: Load) =>
      config.group_by === "stage"
        ? stageLabels[k as keyof typeof stageLabels]
        : (first.carrier_name ?? "Carrier");
    const list = [...map].map(([key, items]) => ({
      key,
      label: label(key, items[0]),
      items,
    }));
    return config.group_by === "stage"
      ? list.sort(
          (a, b) =>
            Object.keys(stageLabels).indexOf(a.key) -
            Object.keys(stageLabels).indexOf(b.key),
        )
      : list.sort((a, b) => a.label.localeCompare(b.label));
  }, [sorted, config.group_by]);
  const columns: { key: ViewConfig["sort"]["key"]; label: string }[] = [
    { key: "reference", label: "Load" },
    ...allFields.filter(show).map((f) => ({ key: f, label: fieldLabels[f] })),
  ];
  const cell = (l: Load, f: ViewField) => {
    switch (f) {
      case "carrier":
        return l.carrier_name ?? "";
      case "stage":
        return l.cancelled_at ? "Cancelled" : stageLabels[l.stage];
      case "next":
        return l.summary?.next
          ? `${l.summary.next.label} ${new Date(l.summary.next.window_start).toLocaleString("en-US", { timeZone: l.summary.next.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
          : "—";
      case "driver":
        return l.summary?.driver_name ?? "—";
      case "docs":
        return l.summary
          ? `${l.summary.docs.accepted}/${loadDocumentTypes.length}`
          : "—";
      case "freight":
        return formatMoney(l.amount_minor);
      default:
        return new Date(l.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
    }
  };
  return (
    <div
      className="tableScroll loadTable"
      role="region"
      aria-label="Load table"
      tabIndex={0}
    >
      <table className="reportTable">
        <caption className="srOnly">Loads</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={
                  config.sort.key === c.key
                    ? config.sort.desc
                      ? "descending"
                      : "ascending"
                    : "none"
                }
              >
                <button
                  type="button"
                  className="sortButton"
                  onClick={() =>
                    onConfig({
                      sort: {
                        key: c.key,
                        desc:
                          config.sort.key === c.key
                            ? !config.sort.desc
                            : c.key === "freight" || c.key === "created",
                      },
                    })
                  }
                >
                  {c.label}
                  {config.sort.key === c.key &&
                    (config.sort.desc ? (
                      <ArrowDownIcon size={11} aria-hidden="true" />
                    ) : (
                      <ArrowUpIcon size={11} aria-hidden="true" />
                    ))}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => {
          const closed = collapsed.has(g.key);
          return (
            <tbody key={g.key || "all"}>
              {config.group_by !== "none" && (
                <tr className="groupRow">
                  <th colSpan={columns.length} scope="colgroup">
                    <button
                      type="button"
                      className="groupToggle"
                      aria-expanded={!closed}
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old);
                          if (!next.delete(g.key)) next.add(g.key);
                          return next;
                        })
                      }
                    >
                      {closed ? (
                        <CaretRightIcon size={12} aria-hidden="true" />
                      ) : (
                        <CaretDownIcon size={12} aria-hidden="true" />
                      )}
                      <strong>{g.label}</strong>
                      <Totals loads={g.items} />
                    </button>
                  </th>
                </tr>
              )}
              {!closed &&
                g.items.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="textButton"
                        disabled={disabled}
                        onClick={() => onOpen(l.id)}
                        aria-label={`Open ${l.reference}`}
                      >
                        {l.reference}
                      </button>
                    </th>
                    {allFields.filter(show).map((f) => (
                      <td key={f}>{cell(l, f)}</td>
                    ))}
                  </tr>
                ))}
            </tbody>
          );
        })}
        {!loads.length && (
          <tbody>
            <tr>
              <td colSpan={columns.length}>No loads match.</td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

export function CalendarView({
  loads,
  config,
  onOpen,
  disabled,
}: {
  loads: Load[];
  config: ViewConfig;
  onOpen: (id: string) => void;
  disabled: boolean;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [open, setOpen] = useState<string | null>(null);
  const field = config.calendar_field;
  const byDay = useMemo(() => {
    const map = new Map<string, Load[]>();
    for (const l of loads) {
      const when = dateOf(l, field);
      if (!when) continue;
      const k = day(when);
      map.set(k, [...(map.get(k) ?? []), l]);
    }
    for (const list of map.values())
      list.sort((a, b) => dateOf(a, field).localeCompare(dateOf(b, field)));
    return map;
  }, [loads, field]);
  const unscheduled = loads.filter((l) => !dateOf(l, field)).length;
  const first = new Date(cursor);
  const lead = (first.getDay() + 6) % 7; // weeks start on Monday
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - lead + i);
    return { d };
  });
  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayKey = dayKey(new Date());
  const title = cursor.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const move = (n: number) =>
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  return (
    <section className="calendar" aria-label="Load calendar">
      <div className="calendarBar">
        <div className="segmented" role="group" aria-label="Month">
          <button
            type="button"
            className="segment"
            aria-label="Previous month"
            onClick={() => move(-1)}
          >
            <CaretLeftIcon size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="segment"
            onClick={() => {
              const d = new Date();
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
          >
            Today
          </button>
          <button
            type="button"
            className="segment"
            aria-label="Next month"
            onClick={() => move(1)}
          >
            <CaretRightIcon size={14} aria-hidden="true" />
          </button>
        </div>
        <h2 aria-live="polite">{title}</h2>
        <small>
          By {field === "next" ? "next appointment" : "created date"}
          {unscheduled > 0 && ` · ${unscheduled} without a date`}
        </small>
      </div>
      <div className="calendarGrid" role="grid" aria-label={title}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((n) => (
          <div key={n} className="calendarHead" role="columnheader">
            {n}
          </div>
        ))}
        {cells.map(({ d }) => {
          const k = dayKey(d);
          const items = byDay.get(k) ?? [];
          const expanded = open === k;
          const visible = expanded ? items : items.slice(0, 3);
          return (
            <div
              key={k}
              role="gridcell"
              className={
                "calendarDay" +
                (d.getMonth() !== cursor.getMonth() ? " outside" : "") +
                (k === todayKey ? " today" : "")
              }
              aria-label={
                d.toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                }) + `: ${items.length} loads`
              }
            >
              <span className="calendarDate">{d.getDate()}</span>
              {visible.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={
                    "calendarEvent level-" +
                    (l.summary?.attention.level ?? "ok")
                  }
                  disabled={disabled}
                  onClick={() => onOpen(l.id)}
                  title={`${l.reference} · ${l.carrier_name ?? ""}`}
                >
                  <span>{time(dateOf(l, field))}</span> {l.reference}
                </button>
              ))}
              {items.length > 3 && (
                <button
                  type="button"
                  className="textButton calendarMore"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : k)}
                >
                  {expanded ? "Show fewer" : `+${items.length - 3} more`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
