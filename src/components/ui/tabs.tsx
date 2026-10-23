"use client";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type TabItem<K extends string> = {
  id: K;
  label: string;
  /** A count shown beside the label, such as the number of records. */
  count?: number;
};

/**
 * Underlined tabs that switch the panel below them (WAI-ARIA tabs pattern):
 * one tab in the Tab order, arrow keys, Home and End move between tabs.
 * Selection is shown by colour and the underline only, never by a heavier
 * weight, so choosing a tab never moves its neighbours.
 */
export function Tabs<K extends string>({
  label,
  idPrefix,
  items,
  value,
  onChange,
  className,
}: {
  /** Names the tab list for assistive technology, e.g. "Organization". */
  label: string;
  /** Ties each tab to the shared panel: `<idPrefix>-tab-<id>`, `<idPrefix>-panel`. */
  idPrefix: string;
  items: readonly TabItem<K>[];
  value: K;
  onChange: (id: K) => void;
  /** A variant class, e.g. the marketing preview's pill tabs. */
  className?: string;
}) {
  const refs = useRef<Partial<Record<K, HTMLButtonElement | null>>>({});
  function onKey(e: KeyboardEvent, index: number) {
    const last = items.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[items[next].id]?.focus();
  }
  return (
    <div
      className={"tabs" + (className ? " " + className : "")}
      role="tablist"
      aria-label={label}
    >
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={value === t.id ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="countBadge">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** The panel the selected tab controls. */
export function TabPanel({
  idPrefix,
  value,
  className,
  children,
}: {
  idPrefix: string;
  value: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel`}
      aria-labelledby={`${idPrefix}-tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
