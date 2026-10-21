"use client";
import { useState } from "react";
import {
  BuildingsIcon,
  MagnifyingGlassIcon,
  ArrowUpRightIcon,
} from "@phosphor-icons/react";
import type { Context } from "@/lib/contracts";
const roles: Record<string, string> = {
  dispatcher: "Dispatcher",
  "carrier-manager": "Carrier manager",
  driver: "Driver · assigned loads only",
};
export function CarrierDirectory({
  context,
  onViewLoads,
  onSetup,
  onAdd,
  busy = false,
}: {
  context: Context;
  onViewLoads: (carrier: string) => void;
  onSetup?: (carrier: string) => void;
  onAdd?: () => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState("");
  const carriers = context.carriers.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section
      className="carrierDirectory"
      aria-label="Authorized carrier directory"
    >
      <div className="directoryIntro">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h2>Carrier accounts</h2>
          <p>The carriers you can work with, and your access to each.</p>
        </div>
        <div className="directoryControls">
          {(context.organizations?.length ?? 0) > 0 && onAdd && (
            <button className="primary" disabled={busy} onClick={onAdd}>
              Add carrier
            </button>
          )}
          <label className="directorySearch">
            <MagnifyingGlassIcon size={18} aria-hidden="true" />
            <span className="srOnly">Search carriers</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search carriers…"
            />
          </label>
        </div>
      </div>
      {carriers.length ? (
        <div className="directoryTable">
          <div className="directoryTableHeading">
            <span>Carrier</span>
            <span>Your access</span>
            <span className="srOnly">Open carrier loads</span>
          </div>
          {carriers.map((c) => (
            <article className="directoryRow" key={c.id}>
              <div className="directoryCarrier">
                <span className="carrierMark">
                  <BuildingsIcon size={22} aria-hidden="true" />
                </span>
                <div>
                  <h3>{c.name}</h3>
                  <small>Authorized workspace access</small>
                </div>
              </div>
              <span className="roleLabel">{roles[c.role] || "Member"}</span>
              <div className="directoryRowActions">
                {c.role !== "driver" && onSetup && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => onSetup(c.id)}
                  >
                    Manage setup
                  </button>
                )}
                <button className="secondary" onClick={() => onViewLoads(c.id)}>
                  View loads
                  <ArrowUpRightIcon size={14} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="directoryEmpty">
          <BuildingsIcon size={40} weight="light" aria-hidden="true" />
          <h3>
            {context.carriers.length
              ? "No matching carriers"
              : "No carrier access yet"}
          </h3>
          <p>
            {context.carriers.length
              ? "Try a different carrier name."
              : "Ask your workspace administrator to grant carrier access."}
          </p>
          {query && (
            <button className="secondary" onClick={() => setQuery("")}>
              Clear search
            </button>
          )}
        </div>
      )}
      <p className="directoryNote">
        Workspace access is separate from dispatch authority. A current verified
        dispatch agreement is checked when booking or assigning a load.
      </p>
    </section>
  );
}
