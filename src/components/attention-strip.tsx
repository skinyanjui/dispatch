"use client";
import { CheckCircleIcon } from "@phosphor-icons/react";
import {
  attentionKeys,
  attentionLabels,
  type AttentionKey,
} from "@/lib/attention";
import { ToggleGroup } from "@/components/ui/toggle-group";

export type AttentionCounts = Record<AttentionKey, number>;

/**
 * The answer to "what needs me right now?" before anyone clicks: counts by
 * reason, each one a filter for the board below (ADR 0029).
 */
export function AttentionStrip({
  counts,
  total,
  truncated,
  active,
  onToggle,
}: {
  counts: AttentionCounts;
  total: number;
  truncated: boolean;
  active: AttentionKey | null;
  onToggle: (key: AttentionKey | null) => void;
}) {
  if (!total)
    return (
      <p className="attention allClear" role="status">
        <CheckCircleIcon size={16} aria-hidden="true" />
        Nothing needs attention right now.
      </p>
    );
  return (
    <section className="attention" aria-label="Needs attention">
      <strong className="attentionTitle">
        {total} {total === 1 ? "load needs" : "loads need"} attention
        {truncated && " (showing the newest)"}
      </strong>
      <ToggleGroup
        label="Show only"
        items={attentionKeys
          .filter((key) => counts[key] > 0)
          .map((key) => ({
            id: key,
            label: attentionLabels[key],
            count: counts[key],
            className: key,
          }))}
        value={active}
        allowNone
        onChange={onToggle}
      />
      {/* Always present, so pressing a chip never reflows the row. */}
      <button
        type="button"
        className={"textButton attentionReset" + (active ? "" : " idle")}
        disabled={!active}
        aria-hidden={!active}
        tabIndex={active ? 0 : -1}
        onClick={() => onToggle(null)}
      >
        Show all loads
      </button>
    </section>
  );
}
