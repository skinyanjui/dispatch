"use client";

import { useEffect, useRef, useState } from "react";
import { MapPinIcon, PlusIcon, ClockIcon } from "@phosphor-icons/react";
import type {
  CheckIn,
  CheckInAmendment,
  CheckInInput,
  Load,
} from "@/lib/contracts";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { appointmentToInstant } from "@/lib/entry";

const zones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

function timestamp(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function localInput(value: number) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function Report({
  report,
  now,
  actions,
}: {
  report: CheckIn;
  now: number;
  actions?: React.ReactNode;
}) {
  const retracted = report.status === "retracted";
  const minutes = Math.floor((now - Date.parse(report.observed_at)) / 60000);
  const stale = minutes >= 120 && !retracted;
  const age =
    minutes < 0
      ? "Reported time is ahead"
      : minutes < 1
        ? "Observed just now"
        : minutes < 60
          ? `Observed ${minutes}m ago`
          : minutes < 1440
            ? `Observed ${Math.floor(minutes / 60)}h ago`
            : `Observed ${Math.floor(minutes / 1440)}d ago`;
  return (
    <article
      className="checkInReport"
      aria-label={`Check-in: ${report.location}`}
    >
      <div className="checkInLocation">
        <MapPinIcon size={16} aria-hidden="true" />
        {retracted ? (
          <del>
            <strong>{report.location}</strong>
          </del>
        ) : (
          <strong>{report.location}</strong>
        )}
        {stale && <span className="checkInStale">Stale</span>}
        {report.status === "corrected" && (
          <span className="checkInStale">Corrected</span>
        )}
        {retracted && <span className="checkInStale">Retracted</span>}
      </div>
      <p className="checkInAge">
        <ClockIcon size={12} aria-hidden="true" />
        {age}
      </p>
      {report.note && <p className="checkInNote">{report.note}</p>}
      <dl className="checkInProvenance">
        <div>
          <dt>Observed</dt>
          <dd>
            <time dateTime={report.observed_at}>
              {timestamp(report.observed_at)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>
            <time dateTime={report.recorded_at}>
              {timestamp(report.recorded_at)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Reporter</dt>
          <dd>{report.actor_name} · Manual</dd>
        </div>
      </dl>
      {report.original && (
        <p className="checkInNote">
          Originally reported as {report.original.location} at{" "}
          {timestamp(report.original.observed_at)}
          {report.original.note && <> — “{report.original.note}”</>}
        </p>
      )}
      {(report.amendments || []).map((a) => (
        <p className="checkInHelp" key={a.created_at + a.action}>
          {a.action === "correct" ? "Corrected" : "Retracted"} by {a.actor_name}{" "}
          on {timestamp(a.created_at)}: {a.reason}
        </p>
      ))}
      {actions}
    </article>
  );
}

export function LoadCheckIns({
  load,
  busy,
  offline,
  onRecord,
  userId,
  role,
  onAmended,
}: {
  load: Load;
  busy: boolean;
  offline: boolean;
  userId?: string;
  role?: string;
  onAmended: (message: string) => Promise<void>;
  onRecord: (
    input: CheckInInput,
  ) => Promise<"saved" | "retry" | "version-conflict">;
}) {
  const [editing, setEditing] = useState(false);
  const [zone, setZone] = useState("UTC");
  const [observed, setObserved] = useState("");
  const [formError, setFormError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const request = useRef<{ payload: string; input: CheckInInput } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const api = useApi();
  const [older, setOlder] = useState<{
    reports: CheckIn[];
    cursor: string | null;
  } | null>(null);
  const [amending, setAmending] = useState<{
    report: CheckIn;
    action: "correct" | "retract";
  } | null>(null);
  const [amendError, setAmendError] = useState("");
  const [amendBusy, setAmendBusy] = useState(false);
  const amendRequest = useRef<{
    payload: string;
    input: CheckInAmendment;
  } | null>(null);
  const reports = [...(load.check_ins || []), ...(older?.reports || [])];
  const cursor = older ? older.cursor : load.check_ins_cursor;
  // The headline is the newest report that has not been retracted.
  const headline = reports.find((r) => r.status !== "retracted") ?? null;
  const canAmend = (r: CheckIn) =>
    !offline &&
    r.status !== "retracted" &&
    (role === "dispatcher" ||
      role === "carrier-manager" ||
      (role === "driver" && !!userId && r.actor_id === userId));
  const actionsFor = (r: CheckIn) =>
    canAmend(r) && !amending ? (
      <div className="checkInActions">
        <button
          type="button"
          className="textButton"
          aria-label={`Correct check-in at ${r.location}`}
          onClick={() => {
            amendRequest.current = null;
            setAmendError("");
            setAmending({ report: r, action: "correct" });
          }}
        >
          Correct
        </button>
        <button
          type="button"
          className="textButton"
          aria-label={`Retract check-in at ${r.location}`}
          onClick={() => {
            amendRequest.current = null;
            setAmendError("");
            setAmending({ report: r, action: "retract" });
          }}
        >
          Retract
        </button>
      </div>
    ) : null;
  async function submitAmendment(change: Record<string, string>) {
    if (!amending) return;
    const payload = JSON.stringify({ id: amending.report.id, ...change });
    // Keep the original key and version across an uncertain retry.
    if (amendRequest.current?.payload !== payload)
      amendRequest.current = {
        payload,
        input: {
          ...change,
          action: amending.action,
          version: load.version,
          idempotency_key: crypto.randomUUID(),
        } as CheckInAmendment,
      };
    setAmendBusy(true);
    setAmendError("");
    try {
      await api(
        `loads/${load.id}/check-ins/${amending.report.id}/amend`,
        amendRequest.current.input,
      );
      const action = amending.action;
      amendRequest.current = null;
      setAmending(null);
      setOlder(null);
      await onAmended(
        action === "correct" ? "Check-in corrected." : "Check-in retracted.",
      );
    } catch (e) {
      const code = e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE";
      if (code === "VERSION_CONFLICT") amendRequest.current = null;
      setAmendError(code);
    } finally {
      setAmendBusy(false);
    }
  }
  async function loadOlder() {
    if (!cursor) return;
    setAmendBusy(true);
    setAmendError("");
    try {
      const page = await api<{ check_ins: CheckIn[]; cursor: string | null }>(
        `loads/${load.id}/check-ins?before=${encodeURIComponent(cursor)}`,
      );
      setOlder({
        reports: [...(older?.reports || []), ...page.check_ins],
        cursor: page.cursor,
      });
    } catch (e) {
      setAmendError(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setAmendBusy(false);
    }
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  function start() {
    const date = new Date();
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setObserved(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    );
    request.current = null;
    setFormError("");
    setEditing(true);
  }
  function close() {
    setEditing(false);
    request.current = null;
    requestAnimationFrame(() => addButton.current?.focus());
  }

  return (
    <section className="checkIns" aria-label="Manual check-ins">
      <div className="checkInHeading">
        <h3>Manual check-ins</h3>
        {!editing && (
          <button
            ref={addButton}
            className="secondary"
            disabled={busy || offline}
            onClick={start}
          >
            <PlusIcon size={14} aria-hidden="true" />
            Add check-in
          </button>
        )}
      </div>
      <p className="checkInHelp">
        Approximate, manually reported locations. Reports older than two hours
        are marked stale.
      </p>
      {editing && (
        <form
          aria-label="Record manual check-in"
          className="checkInForm"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || offline) return;
            const fields = new FormData(event.currentTarget);
            setFormError("");
            let instant: string;
            try {
              instant = appointmentToInstant(observed, zone);
            } catch {
              setFormError(
                "Check the observed time and time zone. A time skipped or repeated by daylight saving needs clarification.",
              );
              return;
            }
            const observation = {
              location: String(fields.get("location")).trim(),
              note: String(fields.get("note")).trim(),
              observed_at: instant,
            };
            // A detail refresh can advance load.version after an uncertain save.
            // Keep the original version and key until this observation is settled.
            const payload = JSON.stringify(observation);
            if (request.current?.payload !== payload)
              request.current = {
                payload,
                input: {
                  ...observation,
                  version: load.version,
                  idempotency_key: crypto.randomUUID(),
                },
              };
            const result = await onRecord(request.current.input);
            if (result === "saved") close();
            else if (result === "version-conflict") request.current = null;
          }}
        >
          <fieldset disabled={busy}>
            <legend>New location report</legend>
            <label>
              Reported location
              <input
                autoFocus
                name="location"
                required
                maxLength={160}
                placeholder="City, state or nearby landmark"
              />
            </label>
            <div className="formGrid">
              <label>
                Observed time
                <input
                  type="datetime-local"
                  value={observed}
                  onChange={(e) => setObserved(e.target.value)}
                  required
                />
              </label>
              <label>
                Time zone
                <select value={zone} onChange={(e) => setZone(e.target.value)}>
                  {[...new Set([zone, ...zones])].map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Check-in note <span className="optionalLabel">Optional</span>
              <textarea
                name="note"
                maxLength={1000}
                rows={3}
                placeholder="What should the next dispatcher know?"
              />
            </label>
            <p className="checkInHelp">
              Use an observation from the last 30 days. Recording a check-in
              keeps the shipment milestone unchanged.
            </p>
            {formError && (
              <p className="checkInFormError" role="alert">
                {formError}
              </p>
            )}
            <div className="checkInActions">
              <button type="button" className="secondary" onClick={close}>
                Cancel check-in
              </button>
              <button className="primary" type="submit" disabled={offline}>
                {busy ? "Recording…" : "Record check-in"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {amending && (
        <form
          className="checkInForm"
          aria-label={
            amending.action === "correct"
              ? "Correct check-in"
              : "Retract check-in"
          }
          onSubmit={async (event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            const reason = String(f.get("reason")).trim();
            if (amending.action === "retract") {
              await submitAmendment({ reason });
              return;
            }
            let instant: string;
            try {
              instant = appointmentToInstant(
                String(f.get("observed")),
                String(f.get("zone")),
              );
            } catch {
              setAmendError(
                "Check the observed time and time zone. A time skipped or repeated by daylight saving needs clarification.",
              );
              return;
            }
            await submitAmendment({
              location: String(f.get("location")).trim(),
              note: String(f.get("note")).trim(),
              observed_at: instant,
              reason,
            });
          }}
        >
          <fieldset disabled={amendBusy || busy}>
            <legend>
              {amending.action === "correct"
                ? `Correct the report at ${amending.report.location}`
                : `Retract the report at ${amending.report.location}`}
            </legend>
            {amending.action === "correct" && (
              <>
                <label>
                  Corrected location
                  <input
                    name="location"
                    required
                    maxLength={160}
                    defaultValue={amending.report.location}
                  />
                </label>
                <div className="formGrid">
                  <label>
                    Observed time
                    <input
                      name="observed"
                      type="datetime-local"
                      required
                      defaultValue={localInput(
                        Date.parse(amending.report.observed_at),
                      )}
                    />
                  </label>
                  <label>
                    Time zone
                    <select
                      name="zone"
                      defaultValue={
                        Intl.DateTimeFormat().resolvedOptions().timeZone ||
                        "UTC"
                      }
                    >
                      {[
                        ...new Set([
                          Intl.DateTimeFormat().resolvedOptions().timeZone ||
                            "UTC",
                          ...zones,
                        ]),
                      ].map((z) => (
                        <option key={z}>{z}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Note <span className="optionalLabel">Optional</span>
                  <textarea
                    name="note"
                    maxLength={1000}
                    rows={2}
                    defaultValue={amending.report.note}
                  />
                </label>
              </>
            )}
            <label>
              Reason
              <input
                name="reason"
                required
                maxLength={500}
                placeholder={
                  amending.action === "correct"
                    ? "What was wrong with the original?"
                    : "Why should this report be disregarded?"
                }
              />
            </label>
            <p className="checkInHelp">
              The original report stays on record; this{" "}
              {amending.action === "correct"
                ? "correction is shown in its place"
                : "retraction is final"}
              .
            </p>
            <div className="checkInActions">
              <button
                type="button"
                className="secondary"
                onClick={() => setAmending(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={offline}>
                {amending.action === "correct"
                  ? "Save correction"
                  : "Retract report"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {amendError && (
        <p className="checkInFormError" role="alert">
          {describe(amendError)}
        </p>
      )}
      {reports.length ? (
        <>
          {headline && (
            <Report
              report={headline}
              now={now}
              actions={actionsFor(headline)}
            />
          )}
          {reports.length > (headline ? 1 : 0) && (
            <details className="checkInHistory" open={!headline || !!older}>
              <summary>
                {headline ? "Previous check-ins" : "Retracted check-ins"} (
                {reports.length - (headline ? 1 : 0)})
              </summary>
              {reports
                .filter((r) => r !== headline)
                .map((report) => (
                  <Report
                    key={report.id}
                    report={report}
                    now={now}
                    actions={actionsFor(report)}
                  />
                ))}
              {cursor && (
                <button
                  type="button"
                  className="secondary"
                  disabled={amendBusy}
                  onClick={() => void loadOlder()}
                >
                  Show older check-ins
                </button>
              )}
            </details>
          )}
        </>
      ) : (
        <p className="checkInEmpty">
          <MapPinIcon size={18} aria-hidden="true" />
          No location reports yet.
        </p>
      )}
    </section>
  );
}
