"use client";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
} from "@/lib/format";

/** How a column's values are formatted, aligned and sorted by default. */
export type ColumnType =
  | "text"
  | "number"
  | "money"
  | "date"
  | "datetime"
  | "status";

/**
 * One column, defined once: its header, where its value comes from, and how
 * it is shown, aligned and sorted. The same definition draws the header and
 * every cell beneath it, so a field's name is never repeated in its rows.
 */
export type ColumnDefinition<T> = {
  id: string;
  header: string;
  /** Read the value from a field, or compute it from the row. */
  accessor: keyof T | ((row: T) => unknown);
  /** Default formatting and alignment; numbers and money align right. */
  type?: ColumnType;
  align?: "left" | "center" | "right";
  /** A width token from the design system (ui.css), not a raw size. */
  width?: "xs" | "sm" | "md" | "lg" | "xl";
  sortable?: boolean;
  /** Sort by this instead of the raw value (e.g. a date for a label). */
  sortValue?: (row: T) => string | number;
  /** Sort largest or newest first the first time the header is chosen. */
  descendingFirst?: boolean;
  /**
   * "low" columns are left out on phones (under 640px); everything else
   * scrolls sideways with the first column held in place.
   */
  priority?: "high" | "low";
  /** The cell that names the row (a `th scope="row"`); usually the first. */
  rowHeader?: boolean;
  render?: (value: unknown, row: T) => ReactNode;
};

export type SortState = { column: string; descending: boolean };

export type RowGroup<T> = { key: string; label: ReactNode; rows: T[] };

const read = <T,>(row: T, c: ColumnDefinition<T>) =>
  typeof c.accessor === "function"
    ? c.accessor(row)
    : (row as Record<PropertyKey, unknown>)[c.accessor as PropertyKey];

function display<T>(row: T, c: ColumnDefinition<T>): ReactNode {
  const value = read(row, c);
  if (c.render) return c.render(value, row);
  if (value === null || value === undefined || value === "") return "—";
  switch (c.type) {
    case "money":
      return formatMoney(value as string | number);
    case "number":
      return formatNumber(Number(value));
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    default:
      return String(value);
  }
}

function sortKey<T>(row: T, c: ColumnDefinition<T>): string | number {
  if (c.sortValue) return c.sortValue(row);
  const value = read(row, c);
  if (c.type === "money" || c.type === "number") return Number(value ?? 0);
  if (c.type === "date" || c.type === "datetime")
    return value ? Date.parse(String(value)) : 0;
  return String(value ?? "").toLowerCase();
}

export function sortRows<T>(
  rows: readonly T[],
  columns: readonly ColumnDefinition<T>[],
  sort: SortState | null,
) {
  const c = sort && columns.find((x) => x.id === sort.column);
  if (!c || !sort) return [...rows];
  return [...rows].sort((a, b) => {
    const x = sortKey(a, c),
      y = sortKey(b, c);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return sort.descending ? -order : order;
  });
}

const alignOf = <T,>(c: ColumnDefinition<T>) =>
  c.align ?? (c.type === "money" || c.type === "number" ? "right" : "left");

const cellClass = <T,>(c: ColumnDefinition<T>) =>
  [
    "align-" + alignOf(c),
    c.width && "w-" + c.width,
    c.priority === "low" && "lowPriority",
  ]
    .filter(Boolean)
    .join(" ");

/**
 * The one table for records: headers once, a row per record, values under
 * their headers. It handles sorting, grouping, client-side paging, row
 * opening, and the loading, error and empty states, so pages only describe
 * their columns and data.
 */
export function DataTable<T>({
  caption,
  columns,
  data,
  getRowId,
  sort: controlledSort,
  onSortChange,
  defaultSort = null,
  groups,
  loading = false,
  error,
  onRetry,
  empty,
  pageSize,
  pageKey,
  onRowOpen,
  openLabel,
  rowClassName,
  disabled = false,
  footer,
  className,
}: {
  /** Names the table (read out, not shown) and the scrolling region. */
  caption: string;
  columns: readonly ColumnDefinition<T>[];
  data: readonly T[];
  getRowId: (row: T) => string;
  /** Controlled sort, e.g. saved with a view; otherwise the table keeps it. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  defaultSort?: SortState | null;
  /** Rows split into collapsible groups (already sorted by the caller). */
  groups?: readonly RowGroup<T>[];
  loading?: boolean;
  /** A message for a failed load; shown with Retry when `onRetry` is set. */
  error?: string | null;
  onRetry?: () => void;
  empty: { title: string; description?: ReactNode; action?: ReactNode };
  /** Show this many rows, then "Show more". */
  pageSize?: number;
  /** Changing this (a filter, say) starts paging again from the top. */
  pageKey?: unknown;
  /** Opening a row: its row-header cell becomes a button. */
  onRowOpen?: (row: T) => void;
  openLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  disabled?: boolean;
  /** Extra `tfoot` rows, given the columns in order (totals, Add new). */
  footer?: (columns: readonly ColumnDefinition<T>[]) => ReactNode;
  className?: string;
}) {
  const [ownSort, setOwnSort] = useState<SortState | null>(defaultSort);
  const sort = controlledSort !== undefined ? controlledSort : ownSort;
  const [shown, setShown] = useState({ key: pageKey, count: pageSize });
  if (shown.key !== pageKey) setShown({ key: pageKey, count: pageSize });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const sorted = useMemo(
    () => (groups ? [] : sortRows(data, columns, sort)),
    [data, columns, sort, groups],
  );
  const choose = (c: ColumnDefinition<T>) => {
    const next = {
      column: c.id,
      descending:
        sort?.column === c.id ? !sort.descending : !!c.descendingFirst,
    };
    if (onSortChange) onSortChange(next);
    if (controlledSort === undefined) setOwnSort(next);
  };
  const visible = shown.count ? sorted.slice(0, shown.count) : sorted;
  const total = groups
    ? groups.reduce((n, g) => n + g.rows.length, 0)
    : data.length;

  // The cell that names each row: the column marked rowHeader, else the first.
  const headerAt = Math.max(
    0,
    columns.findIndex((c) => c.rowHeader),
  );
  const row = (r: T) => {
    const id = getRowId(r);
    return (
      <tr
        key={id}
        className={
          [onRowOpen && "clickRow", rowClassName?.(r)]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onClick={
          onRowOpen && !disabled
            ? (e) => {
                if (!(e.target as HTMLElement).closest("button,a,input,select"))
                  onRowOpen(r);
              }
            : undefined
        }
      >
        {columns.map((c, i) => {
          const header = i === headerAt;
          const content = display(r, c);
          if (!header)
            return (
              <td key={c.id} className={cellClass(c)}>
                {content}
              </td>
            );
          return (
            <th key={c.id} scope="row" className={cellClass(c)}>
              {onRowOpen ? (
                <button
                  type="button"
                  className="textButton rowOpen"
                  disabled={disabled}
                  aria-label={openLabel?.(r)}
                  onClick={() => onRowOpen(r)}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </th>
          );
        })}
      </tr>
    );
  };

  if (error && !total)
    return (
      <div className="tableState alert error" role="alert">
        {error}
        {onRetry && (
          <button type="button" className="secondary" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  if (!total)
    return loading ? (
      <div className="tableState" aria-busy="true">
        <span className="skeletonLine" aria-hidden="true" />
        <span className="srOnly" role="status">
          Loading {caption.toLowerCase()}
        </span>
      </div>
    ) : (
      <div className="tableState tableEmpty" role="status">
        <h3>{empty.title}</h3>
        {empty.description && <p>{empty.description}</p>}
        {empty.action}
      </div>
    );
  return (
    <>
      <div
        className={"dataTable" + (className ? " " + className : "")}
        role="region"
        aria-label={caption}
        aria-busy={loading || undefined}
        tabIndex={0}
      >
        <table>
          <caption className="srOnly">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  className={cellClass(c)}
                  aria-sort={
                    c.sortable
                      ? sort?.column === c.id
                        ? sort.descending
                          ? "descending"
                          : "ascending"
                        : "none"
                      : undefined
                  }
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      className="sortButton"
                      onClick={() => choose(c)}
                    >
                      {c.header}
                      {sort?.column === c.id &&
                        (sort.descending ? (
                          <ArrowDownIcon size={11} aria-hidden="true" />
                        ) : (
                          <ArrowUpIcon size={11} aria-hidden="true" />
                        ))}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          {groups ? (
            groups.map((g) => {
              const isClosed = closed.has(g.key);
              return (
                <tbody key={g.key}>
                  <tr className="groupRow">
                    <th colSpan={columns.length} scope="colgroup">
                      <button
                        type="button"
                        className="groupToggle"
                        aria-expanded={!isClosed}
                        onClick={() =>
                          setClosed((old) => {
                            const next = new Set(old);
                            if (!next.delete(g.key)) next.add(g.key);
                            return next;
                          })
                        }
                      >
                        {isClosed ? (
                          <CaretRightIcon size={12} aria-hidden="true" />
                        ) : (
                          <CaretDownIcon size={12} aria-hidden="true" />
                        )}
                        {g.label}
                      </button>
                    </th>
                  </tr>
                  {!isClosed && g.rows.map(row)}
                </tbody>
              );
            })
          ) : (
            <tbody>{visible.map(row)}</tbody>
          )}
          {footer && <tfoot>{footer(columns)}</tfoot>}
        </table>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          {onRetry && (
            <button type="button" className="secondary" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {!groups && shown.count && sorted.length > shown.count ? (
        <div className="tableMore">
          <span role="status">
            Showing {shown.count} of {sorted.length}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setShown((s) => ({ ...s, count: (s.count ?? 0) + pageSize! }))
            }
          >
            Show more
          </button>
        </div>
      ) : null}
    </>
  );
}
