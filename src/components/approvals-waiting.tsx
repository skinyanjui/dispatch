"use client";
import { useEffect, useState } from "react";
import { SealCheckIcon } from "@phosphor-icons/react";
import { ApiError, useApi } from "@/lib/client-api";

type Waiting = {
  pending: number;
  carriers: { carrier_id: string; name: string; count: number }[];
};

/**
 * Tells approvers, wherever they are in the app, that a payout, contact,
 * carrier-detail or reroute change is waiting for them (ADR 0071). It shows
 * nothing when nothing is waiting, and is refreshed when the page changes.
 */
export function ApprovalsWaiting({
  refreshKey,
  onAuthError,
}: {
  refreshKey: string;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  useEffect(() => {
    let stale = false;
    api<Waiting>("change-control/pending")
      .then((w) => !stale && setWaiting(w))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        // A banner that cannot load stays out of the way.
        if (!stale) setWaiting(null);
      });
    return () => {
      stale = true;
    };
  }, [api, refreshKey, onAuthError]);
  if (!waiting?.pending) return null;
  return (
    <section
      className="attention"
      aria-label="Changes waiting for your approval"
    >
      <strong className="attentionTitle">
        <SealCheckIcon size={16} aria-hidden="true" />{" "}
        {waiting.pending === 1
          ? "1 change is waiting for your approval"
          : `${waiting.pending} changes are waiting for your approval`}
      </strong>
      <span className="rowActions">
        {waiting.carriers.map((c) => (
          <a
            key={c.carrier_id}
            className="secondary"
            href={`/carriers/${c.carrier_id}/documents`}
          >
            Review {c.name} ({c.count})
          </a>
        ))}
      </span>
    </section>
  );
}
