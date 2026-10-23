import type { ReactNode } from "react";

export type Bar = {
  key: string;
  label: ReactNode;
  value: number;
  /** Shown beside the bar, e.g. "12 loads · $4,000.00"; defaults to the value. */
  display?: ReactNode;
  /** Read out for the row instead of the drawing. */
  description: string;
};

/**
 * Values compared as horizontal bars: one row per item with its label, a
 * native `meter` scaled to the largest value, and the figure. Plain HTML
 * and CSS, so it reads as a list and needs no drawing code.
 */
export function BarList({
  label,
  bars,
}: {
  label: string;
  bars: readonly Bar[];
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <ul className="barList" aria-label={label}>
      {bars.map((b) => (
        <li key={b.key}>
          <span className="barLabel">{b.label}</span>
          <meter min={0} max={max} value={b.value} aria-label={b.description} />
          <span className="barValue">{b.display ?? b.value}</span>
        </li>
      ))}
    </ul>
  );
}
