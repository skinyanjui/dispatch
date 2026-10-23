"use client";
import {
  ArrowRightIcon,
  ClockIcon,
  FilesIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { formatMoney } from "@/lib/entry";
import { loadDocumentTypes } from "@/lib/compliance";
import type { Load } from "@/lib/contracts";
import { formatInstant, formatShortDate } from "@/lib/format";

const appointment = (iso: string, timezone: string) =>
  formatInstant(iso, {
    weekday: "short",
    date: "short",
    time: true,
    zone: timezone,
  });

/**
 * A board card that answers the usual questions without opening the load:
 * what is next and when, who has it, how the paperwork stands, and what to do
 * about it (ADR 0029).
 */
export function LoadCard({
  load,
  disabled,
  onOpen,
}: {
  load: Load;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const s = load.summary;
  const level = s?.attention.level ?? "ok";
  // Screen readers get the same answers the card shows.
  const name = [
    `${load.reference} · ${load.carrier_name || "Carrier"}`,
    s?.attention.next_step,
  ]
    .filter(Boolean)
    .join(". ");
  const when = formatShortDate(load.created_at);
  return (
    <button
      className={"loadCard lc level-" + level}
      onClick={() => onOpen(load.id)}
      aria-label={name}
      title={`Created ${when}`}
      disabled={disabled}
    >
      <span className="lcHead">
        <strong className="lcRef" title={load.reference}>
          {load.reference}
        </strong>
        <strong className="lcAmount">{formatMoney(load.amount_minor)}</strong>
      </span>
      <span className="lcSub">
        {load.carrier_name}
        {load.cancelled_at && (
          <span className="badge cancelled">Cancelled</span>
        )}
      </span>
      <span className="lcRoute">
        <span>{load.pickup || "Pickup not recorded"}</span>
        <ArrowRightIcon size={12} aria-hidden="true" />
        <span>
          {load.delivery || "Delivery not recorded"}
          {(load.stop_count ?? 2) > 2 && ` · ${load.stop_count} stops`}
        </span>
      </span>
      {s && (
        <span className="lcFacts">
          {s.next && (
            <span className="lcFact">
              <ClockIcon size={12} aria-hidden="true" />
              {s.next.arrived
                ? `At ${s.next.label.toLowerCase()}`
                : `${s.next.label} ${appointment(s.next.window_start, s.next.timezone)}`}
            </span>
          )}
          {/* "Needs a driver" is already the next step; say it once. */}
          {(s.driver_name || s.attention.next_step !== "Needs a driver") && (
            <span className={"lcFact" + (s.driver_name ? "" : " warn")}>
              <UserIcon size={12} aria-hidden="true" />
              {s.driver_name ?? "No driver"}
            </span>
          )}
          <span
            className={"lcFact" + (s.docs.rejected ? " warn" : "")}
            title="Rate confirmation, bill of lading and proof of delivery accepted"
          >
            <FilesIcon size={12} aria-hidden="true" />
            Docs {s.docs.accepted}/{loadDocumentTypes.length}
          </span>
        </span>
      )}
      {s && !load.cancelled_at && (
        <span className={"cardStep lcStep level-" + level}>
          {s.attention.next_step}
        </span>
      )}
    </button>
  );
}
