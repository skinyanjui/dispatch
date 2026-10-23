import { CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * A row of summary figures that wraps when it is full. Give it a label when
 * the tiles act as filters, so the group is announced.
 */
export function StatTiles({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="stats"
      role={label ? "group" : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/** Placeholder tiles while figures load. */
export function StatTilesLoading({ count }: { count: number }) {
  return (
    <div className="stats" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat skeleton" />
      ))}
    </div>
  );
}

/**
 * One figure: its label, the value, and an optional hint below. With
 * `onSelect` the tile is a button: it filters (`pressed`) or opens the
 * records behind it (`actionLabel`, e.g. "Open loads").
 */
export function StatTile({
  label,
  value,
  hint,
  extra,
  tone,
  onSelect,
  pressed,
  actionLabel,
  disabled = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** More detail under the hint, such as a change from last period. */
  extra?: ReactNode;
  /** Colours the value: "good" green, "bad" red. */
  tone?: "good" | "bad";
  onSelect?: () => void;
  /** Set when the tile is a filter: whether it is applied. */
  pressed?: boolean;
  /** What selecting does, shown under the figure and read out. */
  actionLabel?: string;
  disabled?: boolean;
}) {
  const cls = "stat" + (tone ? " " + tone : "");
  const body = (
    <>
      <small>{label}</small>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
      {extra}
      {onSelect && actionLabel && pressed === undefined && (
        <span className="statAction">
          {actionLabel} <CaretRightIcon size={11} aria-hidden="true" />
        </span>
      )}
    </>
  );
  if (!onSelect) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      className={cls + " link"}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}
