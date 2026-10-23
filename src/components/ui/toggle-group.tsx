"use client";
import type { ReactNode } from "react";

export type ToggleItem<K extends string> = {
  id: K;
  label: ReactNode;
  /** A count beside the label; how it reads is set by `countLabel`. */
  count?: number;
  /** "late" draws the item in the error colour (overdue, late). */
  tone?: "late";
  /** Extra class for one item (for example a divider before it). */
  className?: string;
};

const variants = {
  /** Small rounded filters with a count: attention, follow-ups, invoice states. */
  chips: { group: "chips", item: "chip" },
  /** Joined buttons that pick one option: layout, date range. */
  segmented: { group: "segmented", item: "segment" },
  /** Folder list: stacked in a rail, a chip row on phones (Inbox). */
  folders: { group: "folders", item: "folder" },
} as const;

/**
 * A group of buttons where one (or, with `allowNone`, none) is pressed:
 * filters and option pickers that change what the same view shows. Each
 * button announces its pressed state; the pressed look uses colour and
 * background only, so pressing one never moves the others.
 */
export function ToggleGroup<K extends string>({
  label,
  items,
  value,
  onChange,
  variant = "chips",
  allowNone = false,
  hideEmpty = false,
  countLabel,
  disabled = false,
  className,
  trailing,
}: {
  /** Names the group, e.g. "Date range". */
  label: string;
  items: readonly ToggleItem<K>[];
  value: K | null;
  onChange: (id: K | null) => void;
  variant?: keyof typeof variants;
  /** Pressing the pressed item again clears the choice. */
  allowNone?: boolean;
  /** Leave out items whose count is zero, unless pressed. */
  hideEmpty?: boolean;
  /** Spoken text for a count, e.g. (n) => `${n} unread`. */
  countLabel?: (count: number, item: ToggleItem<K>) => string;
  disabled?: boolean;
  className?: string;
  /** Sits after the buttons, inside the group's row. */
  trailing?: ReactNode;
}) {
  const v = variants[variant];
  return (
    <div
      className={v.group + (className ? " " + className : "")}
      role="group"
      aria-label={label}
    >
      {items
        .filter((i) => !hideEmpty || i.count || value === i.id)
        .map((i) => {
          const pressed = value === i.id;
          return (
            <button
              key={i.id}
              type="button"
              className={
                v.item +
                (i.tone ? " " + i.tone : "") +
                (i.className ? " " + i.className : "")
              }
              aria-pressed={pressed}
              disabled={disabled}
              onClick={() => onChange(pressed && allowNone ? null : i.id)}
            >
              <span className="toggleLabel">{i.label}</span>
              {i.count !== undefined &&
                (i.count > 0 || variant === "chips") && (
                  <span
                    className="toggleCount"
                    aria-label={countLabel ? countLabel(i.count, i) : undefined}
                  >
                    {i.count}
                  </span>
                )}
            </button>
          );
        })}
      {trailing}
    </div>
  );
}
