"use client";
import { useCallback, useEffect, useState } from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import {
  exceptionStatusLabels,
  exceptionTypeLabels,
  type LoadException,
} from "@/lib/exception-rules";
import { severityClass, when } from "./load-exceptions";

export function ExceptionQueue({
  onOpenLoad,
  onShowLoads,
  query = "",
  onClearQuery,
  onAuthError,
  driverOnly,
  revision,
}: {
  revision: number;
  /** Search text from the page header. */
  query?: string;
  onClearQuery?: () => void;
  onShowLoads: () => void;
  onOpenLoad: (id: string) => void;
  onAuthError: (e: unknown) => void;
  driverOnly: boolean;
}) {
  const api = useApi();
  const [status, setStatus] = useState("active"),
    [owner, setOwner] = useState("any"),
    [overdue, setOverdue] = useState(false),
    [all, setItems] = useState<LoadException[] | null>(null),
    [truncated, setTruncated] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [now, setNow] = useState(0);
  const needle = query.trim().toLowerCase();
  const items =
    all && needle
      ? all.filter((e) =>
          [
            e.summary,
            (e as { load_reference?: string }).load_reference,
            (e as { carrier_name?: string }).carrier_name,
            e.owner_name,
            e.type,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : all;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{
        exceptions: LoadException[];
        truncated: boolean;
      }>(
        "exceptions?" +
          new URLSearchParams({
            status,
            owner,
            ...(overdue ? { overdue: "true" } : {}),
          }),
      );
      setNow(Date.now());
      setItems(data.exceptions);
      setTruncated(data.truncated);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setLoading(false);
    }
  }, [api, status, owner, overdue, onAuthError]);
  useEffect(() => {
    // Fetch whenever filters change; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // revision is a refresh signal from exception changes made elsewhere.
  }, [load, revision]);
  return (
    <section className="carrierDirectory" aria-label="Exception queue">
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Exceptions</h2>
          <p>
            Delays, missed appointments and missing paperwork, with an owner and
            a resolution trail.
          </p>
        </div>
        <div className="directoryControls opsFilters">
          <label>
            <span className="srOnly">Exception status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Open and in progress</option>
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
          </label>
          {!driverOnly && (
            <label>
              <span className="srOnly">Owner</span>
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="any">Any owner</option>
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </label>
          )}
          <label className="setupCheckbox">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => setOverdue(e.target.checked)}
            />
            <span>Overdue only</span>
          </label>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <p className="srOnly" role="status">
        {loading
          ? "Loading exceptions"
          : items
            ? `${items.length} exceptions shown`
            : ""}
      </p>
      {items && items.length > 0 && (
        <div className="opsList">
          {items.map((item) => (
            <article className="opsCard" key={item.id}>
              <div className="opsCardHeading">
                <WarningIcon size={16} aria-hidden="true" />
                <h3>{item.summary}</h3>
                <span className={"opsPill " + severityClass(item.severity)}>
                  {item.severity}
                </span>
                <span
                  className={
                    "opsPill " + (item.status === "resolved" ? "good" : "")
                  }
                >
                  {exceptionStatusLabels[item.status]}
                </span>
              </div>
              <p className="opsMeta">
                {item.load_reference} · {item.carrier_name} ·{" "}
                {exceptionTypeLabels[item.type]} · Owner{" "}
                {item.owner_name || "unassigned"}
                {item.due_at && (
                  <>
                    {" "}
                    · Due {when(item.due_at)}
                    {item.status !== "resolved" &&
                      Date.parse(item.due_at) < now && (
                        <strong> (overdue)</strong>
                      )}
                  </>
                )}
              </p>
              <button
                className="secondary"
                onClick={() => onOpenLoad(item.load_id)}
                aria-label={`Open load ${item.load_reference} for exception ${item.summary}`}
              >
                Open load
              </button>
            </article>
          ))}
        </div>
      )}
      {items && !items.length && !loading && (
        <div className="directoryEmpty">
          <WarningIcon size={40} weight="light" aria-hidden="true" />
          <h3>No exceptions match</h3>
          {needle ? (
            <>
              <p>Try a different load, carrier or word.</p>
              {onClearQuery && (
                <button className="secondary" onClick={onClearQuery}>
                  Clear search
                </button>
              )}
            </>
          ) : (
            <>
              <p>Exceptions are raised on a load.</p>
              <button className="secondary" onClick={onShowLoads}>
                Choose a load
              </button>
            </>
          )}
        </div>
      )}
      {truncated && (
        <p className="helpText">
          Showing the 100 most urgent. Narrow the filters to see others.
        </p>
      )}
    </section>
  );
}
