"use client";
import { CheckCircleIcon } from "@phosphor-icons/react";
import {
  attentionKeys,
  attentionLabels,
  type AttentionKey,
} from "@/lib/attention";

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
      <div className="attentionChips" role="group" aria-label="Show only">
        {attentionKeys
          .filter((key) => counts[key] > 0)
          .map((key) => (
            <button
              key={key}
              type="button"
              className={"attentionChip " + key}
              aria-pressed={active === key}
              onClick={() => onToggle(active === key ? null : key)}
            >
              {attentionLabels[key]}
              <b>{counts[key]}</b>
            </button>
          ))}
        {active && (
          <button
            type="button"
            className="textButton"
            onClick={() => onToggle(null)}
          >
            Show all loads
          </button>
        )}
      </div>
    </section>
  );
}
