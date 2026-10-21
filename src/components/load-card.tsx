"use client";
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  BuildingsIcon,
  ClockIcon,
  FilesIcon,
  TruckIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { formatMoney } from "@/lib/entry";
import { loadDocumentTypes } from "@/lib/compliance";
import type { Load } from "@/lib/contracts";

const appointment = (iso: string, timezone: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
  return (
    <button
      className={"loadCard level-" + level}
      onClick={() => onOpen(load.id)}
      aria-label={name}
      disabled={disabled}
    >
      <span className="cardTitle">
        <TruckIcon size={17} aria-hidden="true" />
        <strong title={load.reference}>{load.reference}</strong>
        <ArrowUpRightIcon size={14} className="cardArrow" aria-hidden="true" />
      </span>
      <span className="cardCarrier">
        <BuildingsIcon size={13} aria-hidden="true" />
        {load.carrier_name}
        {load.cancelled_at && (
          <span className="badge cancelled">Cancelled</span>
        )}
      </span>
      <span className="cardRoute">
        <span>{load.pickup || "Pickup not recorded"}</span>
        <ArrowDownIcon size={12} aria-hidden="true" />
        <span>
          {load.delivery || "Delivery not recorded"}
          {(load.stop_count ?? 2) > 2 && ` · ${load.stop_count} stops`}
        </span>
      </span>
      {s && (
        <span className="cardFacts">
          {s.next && (
            <span className="cardFact">
              <ClockIcon size={13} aria-hidden="true" />
              {s.next.arrived
                ? `At ${s.next.label.toLowerCase()}`
                : `${s.next.label} ${appointment(s.next.window_start, s.next.timezone)}`}
            </span>
          )}
          {/* "Needs a driver" is already the next step; say it once. */}
          {(s.driver_name || s.attention.next_step !== "Needs a driver") && (
            <span className={"cardFact" + (s.driver_name ? "" : " warn")}>
              <UserIcon size={13} aria-hidden="true" />
              {s.driver_name ?? "No driver"}
            </span>
          )}
          <span
            className={"cardFact" + (s.docs.rejected ? " warn" : "")}
            title="Rate confirmation, bill of lading and proof of delivery accepted"
          >
            <FilesIcon size={13} aria-hidden="true" />
            Docs {s.docs.accepted}/{loadDocumentTypes.length}
          </span>
        </span>
      )}
      {s && !load.cancelled_at && (
        <span className={"cardStep level-" + level}>
          {s.attention.next_step}
        </span>
      )}
      <span className="cardBottom">
        <span>
          {new Date(load.created_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </span>
        <strong>{formatMoney(load.amount_minor)}</strong>
      </span>
    </button>
  );
}
