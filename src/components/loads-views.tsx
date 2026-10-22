"use client";
import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretDownIcon,
  PlusIcon,
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
export type Calc =
  | "none"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "earliest"
  | "latest"
  | "filled"
  | "empty"
  | "unique";
export const calcLabels: Record<Calc, string> = {
  none: "Calculate",
  sum: "Sum",
  average: "Average",
  min: "Min",
  max: "Max",
  earliest: "Earliest",
  latest: "Latest",
  filled: "Filled",
  empty: "Empty",
  unique: "Unique",
};
/** Which aggregations make sense for each column's type. */
export const calcOptions: Record<ViewField, Calc[]> = {
  carrier: ["none", "filled", "empty", "unique"],
  stage: ["none", "unique"],
  next: ["none", "earliest", "latest", "filled", "empty"],
  driver: ["none", "filled", "empty", "unique"],
  docs: ["none", "sum", "average", "min", "max"],
  freight: ["none", "sum", "average", "min", "max"],
  created: ["none", "earliest", "latest"],
};
const formatNext = (l: Load) =>
  l.summary?.next
    ? `${l.summary.next.label} ${new Date(l.summary.next.window_start).toLocaleString("en-US", { timeZone: l.summary.next.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "—";
const formatCreated = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const textOf = (l: Load, f: "carrier" | "stage" | "driver") =>
  f === "carrier"
    ? (l.carrier_name ?? "")
    : f === "stage"
      ? stageLabels[l.stage]
      : (l.summary?.driver_name ?? "");
/** Integer min/max/sum/average (half up) over BigInt values. */
function reduceBig(values: bigint[], calc: Calc) {
  const n = BigInt(values.length);
  const total = values.reduce((t, a) => t + a, 0n);
  return calc === "sum"
    ? total
    : calc === "average"
      ? (total * 2n + n) / (n * 2n)
      : values.reduce((m, a) =>
          calc === "min" ? (a < m ? a : m) : a > m ? a : m,
        );
}
/** Footer figure for one column over the loads shown; "" when there is nothing to show. */
export function calcColumn(loads: Load[], field: ViewField, calc: Calc) {
  if (calc === "none" || !loads.length || !calcOptions[field].includes(calc))
    return "";
  switch (field) {
    case "freight":
      return formatMoney(
        reduceBig(
          loads.map((l) => BigInt(l.amount_minor)),
          calc,
        ).toString(),
      );
    case "docs": {
      // Accepted documents out of those required, for loads with a summary.
      const counted = loads.filter((l) => l.summary);
      if (!counted.length) return "";
      const required = loadDocumentTypes.length;
      const accepted = counted.map((l) => BigInt(l.summary!.docs.accepted));
      if (calc === "sum")
        return `${reduceBig(accepted, calc)}/${counted.length * required}`;
      if (calc === "average") {
        // One decimal, rounded half up, in integer tenths.
        const n = BigInt(accepted.length);
        const tenths = (reduceBig(accepted, "sum") * 20n + n) / (n * 2n);
        return `${tenths / 10n}.${tenths % 10n}/${required}`;
      }
      return `${reduceBig(accepted, calc)}/${required}`;
    }
    case "next": {
      const dated = loads.filter((l) => l.summary?.next);
      if (calc === "filled") return String(dated.length);
      if (calc === "empty") return String(loads.length - dated.length);
      if (!dated.length) return "";
      const at = (l: Load) => Date.parse(l.summary!.next!.window_start);
      return formatNext(
        dated.reduce((m, l) =>
          calc === "earliest" ? (at(l) < at(m) ? l : m) : at(l) > at(m) ? l : m,
        ),
      );
    }
    case "created": {
      const at = (l: Load) => Date.parse(l.created_at);
      const pick = loads.reduce((m, l) =>
        calc === "earliest" ? (at(l) < at(m) ? l : m) : at(l) > at(m) ? l : m,
      );
      return formatCreated(pick.created_at);
    }
    default: {
      const values = loads.map((l) => textOf(l, field));
      if (calc === "filled") return String(values.filter(Boolean).length);
      if (calc === "empty") return String(values.filter((v) => !v).length);
      return String(new Set(values.filter(Boolean)).size);
    }
  }
}
/** Freight totals in integer minor units; the average rounds half up. */
export const calcFreight = (loads: Load[], calc: Calc) =>
  calcColumn(loads, "freight", calc);
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
  onAdd,
  disabled,
}: {
  loads: Load[];
  config: ViewConfig;
  onConfig: (patch: Partial<ViewConfig>) => void;
  onOpen: (id: string) => void;
  /** Opens the new-load form; omitted when the person cannot create loads. */
  onAdd?: () => void;
  disabled: boolean;
}) {
  const [calcs, setCalcs] = useState<Partial<Record<ViewField, Calc>>>({});
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
        return formatNext(l);
      case "driver":
        return l.summary?.driver_name ?? "—";
      case "docs":
        return l.summary
          ? `${l.summary.docs.accepted}/${loadDocumentTypes.length}`
          : "—";
      case "freight":
        return formatMoney(l.amount_minor);
      default:
        return formatCreated(l.created_at);
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
        <tfoot>
          {onAdd && (
            <tr className="addRow">
              <td colSpan={columns.length}>
                <button
                  type="button"
                  className="textButton"
                  disabled={disabled}
                  onClick={onAdd}
                >
                  <PlusIcon size={12} aria-hidden="true" /> Add new
                </button>
              </td>
            </tr>
          )}
          <tr className="calcRow">
            <th scope="row">
              {loads.length} {loads.length === 1 ? "load" : "loads"}
            </th>
            {allFields.filter(show).map((f) => {
              const calc = calcs[f] ?? "none";
              return (
                <td key={f}>
                  <label className="calcPicker">
                    <span className="srOnly">
                      Calculate {fieldLabels[f].toLowerCase()}
                    </span>
                    <select
                      value={calc}
                      onChange={(e) =>
                        setCalcs((old) => ({
                          ...old,
                          [f]: e.target.value as Calc,
                        }))
                      }
                    >
                      {calcOptions[f].map((c) => (
                        <option key={c} value={c}>
                          {calcLabels[c]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <output aria-label={`${fieldLabels[f]} calculation`}>
                    {calcColumn(loads, f, calc)}
                  </output>
                </td>
              );
            })}
          </tr>
        </tfoot>
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
      {/* Phones: the grid is too small to read, so the month is a list. */}
      <div className="calendarAgenda" aria-label={`Loads in ${title}`}>
        {(() => {
          const days = cells
            .filter(({ d }) => d.getMonth() === cursor.getMonth())
            .map(({ d }) => ({ d, items: byDay.get(dayKey(d)) ?? [] }))
            .filter((x) => x.items.length > 0);
          if (!days.length)
            return <p className="calendarNone">No loads this month.</p>;
          return days.map(({ d, items }) => (
            <section key={dayKey(d)} className="agendaDay">
              <h3 className={dayKey(d) === todayKey ? "today" : undefined}>
                {d.toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </h3>
              <ul>
                {items.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      className={
                        "agendaItem level-" +
                        (l.summary?.attention.level ?? "ok")
                      }
                      disabled={disabled}
                      onClick={() => onOpen(l.id)}
                    >
                      <span className="agendaTime">
                        {time(dateOf(l, field))}
                      </span>
                      <strong>{l.reference}</strong>
                      <small>{l.carrier_name ?? ""}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ));
        })()}
      </div>
    </section>
  );
}
