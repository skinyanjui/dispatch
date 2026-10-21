"use client";

import { useEffect, useRef, useState } from "react";
import { MapPinIcon, PlusIcon, ClockIcon } from "@phosphor-icons/react";
import type { CheckIn, CheckInInput, Load } from "@/lib/contracts";
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

function Report({ report, now }: { report: CheckIn; now: number }) {
  const minutes = Math.floor((now - Date.parse(report.observed_at)) / 60000);
  const stale = minutes >= 120;
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
        <strong>{report.location}</strong>
        {stale && <span className="checkInStale">Stale</span>}
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
    </article>
  );
}

export function LoadCheckIns({
  load,
  busy,
  offline,
  onRecord,
}: {
  load: Load;
  busy: boolean;
  offline: boolean;
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
  const reports = load.check_ins || [];

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
      {reports.length ? (
        <>
          <Report report={reports[0]} now={now} />
          {reports.length > 1 && (
            <details className="checkInHistory">
              <summary>Previous check-ins ({reports.length - 1})</summary>
              {reports.slice(1).map((report) => (
                <Report key={report.id} report={report} now={now} />
              ))}
            </details>
          )}
          {reports.length === 50 && (
            <p className="checkInHelp">Showing the latest 50 observations.</p>
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
