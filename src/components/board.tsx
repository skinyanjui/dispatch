"use client";
import { CircleIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

export type BoardLane<T> = {
  id: string;
  label: string;
  items: T[];
  /** Beside the lane name: a count, or a count and a total. */
  count: ReactNode;
};

/**
 * The one kanban board (Loads, Prospects): lanes with a coloured dot, name and
 * count, cards stacked under them, one empty state, and dragging a card to
 * another lane where the page allows it. Dragging is a shortcut only; every
 * move can also be made from the record itself.
 */
export function Board<T>({
  label,
  noun,
  lanes,
  laneClass,
  className = "",
  compact = false,
  itemKey,
  renderCard,
  empty,
  canDrag,
  onMove,
}: {
  /** "Load board"; each lane is "<lane> <noun>". */
  label: string;
  noun: string;
  lanes: BoardLane<T>[];
  /** Extra class per lane, for its dot colour. */
  laneClass?: (id: string) => string;
  className?: string;
  compact?: boolean;
  itemKey: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  /** What an empty lane says (loading, failed, nothing here). */
  empty: string;
  /** Whether this card may be dragged now; omit to turn dragging off. */
  canDrag?: (item: T) => boolean;
  onMove?: (id: string, lane: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const movable = Boolean(onMove && canDrag);
  return (
    <div
      className={
        "kanban" +
        (compact ? " compact" : "") +
        (className ? " " + className : "")
      }
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {lanes.map((lane) => (
        <section
          key={lane.id}
          className={
            "lane " +
            (laneClass ? laneClass(lane.id) : lane.id) +
            (over === lane.id ? " dropping" : "")
          }
          aria-label={`${lane.label} ${noun}`}
          {...(movable && {
            onDragOver: (e: React.DragEvent) => {
              e.preventDefault();
              setOver(lane.id);
            },
            onDragLeave: () => setOver(null),
            onDrop: (e: React.DragEvent) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/plain");
              if (id) onMove!(id, lane.id);
            },
          })}
        >
          <div className="laneHeading">
            <CircleIcon weight="fill" size={9} aria-hidden="true" />
            <h2>{lane.label}</h2>
            <span className="laneCount">{lane.count}</span>
          </div>
          <div className="laneCards">
            {lane.items.map((item) => (
              <div
                key={itemKey(item)}
                className="cardDrag"
                draggable={movable && canDrag!(item)}
                onDragStart={(e) =>
                  e.dataTransfer.setData("text/plain", itemKey(item))
                }
              >
                {renderCard(item)}
              </div>
            ))}
            {!lane.items.length && <div className="laneEmpty">{empty}</div>}
          </div>
        </section>
      ))}
    </div>
  );
}
