"use client";
import { useRef, useState } from "react";
import { ClockIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { Load } from "@/lib/contracts";
import { appointmentToInstant } from "@/lib/entry";
import {
  detentionMinutes,
  stopTiming,
  type StopEvent,
  type StopEventKind,
  type TimedStop,
} from "@/lib/stop-timing";

function inZone(value: string, timezone: string, withDate = false) {
  return new Date(value).toLocaleString("en-US", {
    timeZone: timezone,
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
function appointmentLabel(start: string, end: string, timezone: string) {
  const format = (value: string) =>
    new Date(value).toLocaleString("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const day = (value: string) =>
    new Date(value).toLocaleDateString("en-CA", { timeZone: timezone });
  const time = (value: string) =>
    new Date(value).toLocaleTimeString("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    });
  if (new Date(start).getTime() === new Date(end).getTime())
    return format(start);
  // Same day: say the date once ("Nov 5, 2026, 9:00 AM – 10:00 AM").
  return day(start) === day(end)
    ? `${format(start)} – ${time(end)}`
    : `${format(start)} – ${format(end)}`;
}
const duration = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
    : `${minutes}m`;
/** `datetime-local` value for "now" in the stop's own time zone. */
function nowInZone(timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const labels: Record<StopEventKind, string> = {
  arrived: "Arrived",
  departed: "Departed",
};

type Draft = {
  stop: TimedStop;
  kind: StopEventKind;
  current: StopEvent | null;
};

/** Route with per-stop arrival/departure reporting (ADR 0014). */
export function StopList({
  load,
  canReport,
  disabled,
  onChanged,
}: {
  load: Load;
  canReport: boolean;
  disabled: boolean;
  onChanged: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [draft, setDraft] = useState<Draft | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const attempt = useRef<{
    signature: string;
    key: string;
    version: number;
  } | null>(null);
  const stops = load.stops || [];
  async function submit(form: FormData) {
    if (!draft?.stop.id) return;
    let occurred: string;
    try {
      occurred = appointmentToInstant(
        String(form.get("time")),
        draft.stop.timezone,
      );
    } catch {
      setError(describe("VALIDATION_ERROR"));
      return;
    }
    const body: Record<string, unknown> = {
      kind: draft.kind,
      occurred_at: occurred,
      note: String(form.get("note") || "").trim(),
      ...(draft.current
        ? {
            supersedes: draft.current.id,
            reason: String(form.get("reason")).trim(),
          }
        : {}),
    };
    // Keep key and version stable across an uncertain retry.
    const signature = draft.stop.id + JSON.stringify(body);
    if (attempt.current?.signature !== signature)
      attempt.current = {
        signature,
        key: crypto.randomUUID(),
        version: load.version,
      };
    setBusy(true);
    setError("");
    try {
      await api(`loads/${load.id}/stops/${draft.stop.id}/events`, {
        ...body,
        version: attempt.current.version,
        idempotency_key: attempt.current.key,
      });
      const message = `${labels[draft.kind]} time ${draft.current ? "corrected" : "recorded"}.`;
      attempt.current = null;
      setDraft(null);
      await onChanged(message);
    } catch (e) {
      const code = e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE";
      if (["VERSION_CONFLICT", "STOP_EVENT_CHANGED"].includes(code))
        attempt.current = null;
      setError(code);
    } finally {
      setBusy(false);
    }
  }
  const open = (stop: TimedStop, kind: StopEventKind) => {
    attempt.current = null;
    setError("");
    setDraft({ stop, kind, current: stop[kind] ?? null });
  };
  return (
    <div className="stops">
      {stops.map((s, i) => {
        const timing = stopTiming(s);
        const label = `stop ${i + 1}`;
        return (
          <article
            className="stop"
            key={s.id ?? i}
            aria-label={`Stop ${i + 1}: ${s.address}`}
          >
            <span className="stopIndex">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <small>{s.kind}</small>
              <strong>{s.address}</strong>
              <p>
                <ClockIcon size={13} aria-hidden="true" />
                <span>
                  {appointmentLabel(s.window_start, s.window_end, s.timezone)}
                </span>
              </p>
              <span className="stopZone">{s.timezone}</span>
              {(s.arrived || s.departed) && (
                <ul className="stopTimes">
                  {s.arrived && (
                    <li>
                      Arrived {inZone(s.arrived.occurred_at, s.timezone, true)}
                      {timing.lateMinutes > 0 ? (
                        <span className="opsPill warn">
                          {duration(timing.lateMinutes)} late
                        </span>
                      ) : (
                        <span className="opsPill good">On time</span>
                      )}
                    </li>
                  )}
                  {s.departed && (
                    <li>
                      Departed{" "}
                      {inZone(s.departed.occurred_at, s.timezone, true)}
                      {timing.dwellMinutes !== null && (
                        <span
                          className={
                            "opsPill " +
                            (timing.dwellMinutes >= detentionMinutes
                              ? "warn"
                              : "")
                          }
                        >
                          {duration(timing.dwellMinutes)} on site
                          {timing.dwellMinutes >= detentionMinutes
                            ? " · check detention"
                            : ""}
                        </span>
                      )}
                    </li>
                  )}
                </ul>
              )}
              {(s.stop_events?.length ?? 0) >
                [s.arrived, s.departed].filter(Boolean).length && (
                <details className="docHistory">
                  <summary>Time history ({s.stop_events!.length})</summary>
                  {s.stop_events!.map((e) => (
                    <p className="opsMeta" key={e.id}>
                      {labels[e.kind]} {inZone(e.occurred_at, s.timezone, true)}{" "}
                      · {e.actor_name}
                      {e.reason && <> · corrected: {e.reason}</>}
                    </p>
                  ))}
                </details>
              )}
              {canReport && s.id && draft?.stop.id !== s.id && (
                <div className="opsActions stopActions">
                  {(["arrived", "departed"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="textButton"
                      disabled={
                        disabled || busy || (kind === "departed" && !s.arrived)
                      }
                      aria-label={`${s[kind] ? "Correct" : "Record"} ${kind === "arrived" ? "arrival at" : "departure from"} ${label}`}
                      onClick={() => open(s, kind)}
                    >
                      {s[kind]
                        ? `Correct ${kind === "arrived" ? "arrival" : "departure"}`
                        : kind === "arrived"
                          ? "Record arrival"
                          : "Record departure"}
                    </button>
                  ))}
                </div>
              )}
              {draft && draft.stop.id === s.id && s.id && (
                <form
                  className="opsForm"
                  aria-label={`${labels[draft.kind]} time for ${label}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit(new FormData(e.currentTarget));
                  }}
                >
                  <label>
                    {labels[draft.kind]} time ({s.timezone})
                    <input
                      name="time"
                      type="datetime-local"
                      required
                      defaultValue={nowInZone(s.timezone)}
                    />
                  </label>
                  {draft.current && (
                    <label>
                      Reason for correction
                      <input name="reason" required maxLength={500} />
                    </label>
                  )}
                  <label>
                    Note <small>(optional)</small>
                    <input name="note" maxLength={500} />
                  </label>
                  <div className="opsActions">
                    <button className="primary" disabled={disabled || busy}>
                      {draft.current
                        ? "Save correction"
                        : `Save ${labels[draft.kind].toLowerCase()} time`}
                    </button>
                    <button
                      type="button"
                      className="textButton"
                      onClick={() => setDraft(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </article>
        );
      })}
      {error && (
        <p className="alert error" role="alert">
          {describe(error)}
        </p>
      )}
    </div>
  );
}
