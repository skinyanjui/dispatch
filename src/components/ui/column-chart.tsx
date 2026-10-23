import type { ReactNode } from "react";

export type Column = {
  key: string;
  value: number;
  /** Under the column, e.g. "10-14". */
  label: ReactNode;
  /** Read out instead of the drawing, e.g. "Week of 10-14: 12 loads, $4,000". */
  description: string;
};

/**
 * A small column chart: the value above each column and its label below.
 * Columns are drawn in SVG scaled to the largest value, so no sizes are set
 * inline; the drawing is hidden from assistive technology and each column's
 * description is read instead.
 */
export function ColumnChart({
  label,
  columns,
}: {
  label: string;
  columns: readonly Column[];
}) {
  const max = Math.max(1, ...columns.map((c) => c.value));
  return (
    <ol className="columnChart" aria-label={label}>
      {columns.map((c) => {
        // At least a sliver, so a zero still shows where the column is.
        const h = Math.max(3, (c.value / max) * 100);
        return (
          <li key={c.key} title={c.description}>
            <strong aria-hidden="true">{c.value}</strong>
            <svg
              className="column"
              viewBox="0 0 10 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="0" y={100 - h} width="10" height={h} rx="1" />
            </svg>
            <small aria-hidden="true">{c.label}</small>
            <span className="srOnly">{c.description}</span>
          </li>
        );
      })}
    </ol>
  );
}
