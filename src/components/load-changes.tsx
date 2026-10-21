"use client";
import { useRef, useState } from "react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { Load } from "@/lib/contracts";
import { appointmentToInstant, dollarsToMinor } from "@/lib/entry";
import { Sheet } from "./modal";

/** `datetime-local` value for an instant, in the stop's own time zone. */
function localValue(instant: string, timezone: string) {
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
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const minorToDollars = (minor: string | number) => {
  const v = BigInt(minor);
  return `${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
};
const fieldLabels: Record<string, string> = {
  reference: "Reference",
  source: "Booking source",
  amount_minor: "Agreed rate",
  address: "Address",
  timezone: "Time zone",
  window_start: "Appointment start",
  window_end: "Appointment end",
};
const show = (field: string, value: string) =>
  field === "amount_minor"
    ? "$" + minorToDollars(value)
    : field.startsWith("window")
      ? new Date(value).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : value;

export function LoadChanges({
  load,
  canChange,
  disabled,
  onChanged,
  onAuthError,
}: {
  load: Load;
  canChange: boolean;
  disabled: boolean;
  onChanged: (message: string) => Promise<void>;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [mode, setMode] = useState<"edit" | "cancel" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const open = canChange && !load.cancelled_at && load.stage !== "delivered";
  // A retry of the same form reuses its key so a request that did succeed is
  // replayed, not rejected for its stale version; edited input gets a new key.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  async function run(path: string, body: unknown, done: string) {
    setBusy(true);
    setError("");
    try {
      const json = path + JSON.stringify(body);
      if (attempt.current?.body !== json)
        attempt.current = { body: json, key: crypto.randomUUID() };
      await api(`loads/${load.id}/${path}`, body, attempt.current.key);
      attempt.current = null;
      setMode(null);
      await onChanged(done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  const reasonRequired = load.stage !== "booked";
  const stops = (load.stops ?? []).filter((s) => !s.arrived && !s.departed);
  return (
    <>
      {load.cancelled_at && (
        <div className="alert error" role="status">
          <strong>Cancelled.</strong> {load.cancel_reason}
        </div>
      )}
      {open && (
        <div className="actionRow">
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => {
              setError("");
              setMode("edit");
            }}
          >
            Edit load
          </button>
          {(load.stage === "booked" || load.stage === "dispatched") && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => {
                setError("");
                setMode("cancel");
              }}
            >
              Cancel load
            </button>
          )}
        </div>
      )}
      {(load.changes?.length ?? 0) > 0 && (
        <details className="changeLog">
          <summary>Change history ({load.changes!.length})</summary>
          <ul>
            {load.changes!.map((c, i) => (
              <li key={i}>
                <strong>{fieldLabels[c.field] ?? c.field}</strong>:{" "}
                {show(c.field, c.old_value)} → {show(c.field, c.new_value)}
                <small>
                  {" "}
                  {c.actor_name},{" "}
                  {new Date(c.created_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {c.reason && ` — ${c.reason}`}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {mode === "edit" && (
        <Sheet
          label="Edit load"
          eyebrow="EDIT LOAD"
          onClose={() => setMode(null)}
        >
          <form
            className="opsForm"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              let body: Record<string, unknown>;
              try {
                body = {
                  version: load.version,
                  reason: String(f.get("reason") || "").trim(),
                  reference: String(f.get("reference")).trim(),
                  source: String(f.get("source")).trim(),
                  amountMinor: dollarsToMinor(String(f.get("rate"))),
                  stops: stops.map((s) => ({
                    id: s.id,
                    address: String(f.get("address-" + s.id)).trim(),
                    windowStart: appointmentToInstant(
                      String(f.get("start-" + s.id)),
                      s.timezone,
                    ),
                    windowEnd: appointmentToInstant(
                      String(f.get("end-" + s.id)),
                      s.timezone,
                    ),
                  })),
                };
              } catch (err) {
                setError(err instanceof Error ? err.message : "INVALID");
                return;
              }
              void run("edit", body, "All saved. The load is up to date.");
            }}
          >
            <h2>Edit {load.reference}</h2>
            <p className="helpText">
              Change only what you need. We&apos;ll save just those fields and
              keep a note of what they were before and who changed them.
              {load.assignment &&
                " Your driver will get a friendly heads-up about address or time changes."}
            </p>
            <div className="formGrid">
              <label>
                Reference
                <input
                  name="reference"
                  required
                  maxLength={100}
                  defaultValue={load.reference}
                />
              </label>
              <label>
                Booking source
                <input
                  name="source"
                  required
                  maxLength={100}
                  defaultValue={load.source}
                />
              </label>
              <label>
                Agreed rate (USD)
                <input
                  name="rate"
                  required
                  inputMode="decimal"
                  defaultValue={minorToDollars(load.amount_minor)}
                />
              </label>
            </div>
            {stops.map((s, i) => (
              <fieldset key={s.id} className="stopFields">
                <legend>
                  Stop {i + 1} · {s.kind === "pickup" ? "Pickup" : "Delivery"} (
                  {s.timezone})
                </legend>
                <label>
                  Address
                  <input
                    name={"address-" + s.id}
                    required
                    minLength={3}
                    maxLength={500}
                    defaultValue={s.address}
                  />
                </label>
                <div className="formGrid">
                  <label>
                    Window start
                    <input
                      type="datetime-local"
                      name={"start-" + s.id}
                      required
                      defaultValue={localValue(s.window_start, s.timezone)}
                    />
                  </label>
                  <label>
                    Window end
                    <input
                      type="datetime-local"
                      name={"end-" + s.id}
                      required
                      defaultValue={localValue(s.window_end, s.timezone)}
                    />
                  </label>
                </div>
              </fieldset>
            ))}
            {(load.stops ?? []).length > stops.length && (
              <small>
                Stops with a recorded arrival can no longer be changed.
              </small>
            )}
            <label>
              Reason {reasonRequired ? "(required)" : "(optional)"}
              <input name="reason" maxLength={500} required={reasonRequired} />
            </label>
            {error && (
              <div className="alert error" role="alert">
                {describe(error)}
              </div>
            )}
            <div className="opsActions">
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                className="textButton"
                onClick={() => setMode(null)}
              >
                Close
              </button>
            </div>
          </form>
        </Sheet>
      )}
      {mode === "cancel" && (
        <Sheet
          label="Cancel load"
          eyebrow="CANCEL LOAD"
          onClose={() => setMode(null)}
        >
          <form
            className="opsForm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                "cancel",
                {
                  version: load.version,
                  reason: String(
                    new FormData(e.currentTarget).get("reason"),
                  ).trim(),
                },
                "Done. The load has been cancelled.",
              );
            }}
          >
            <h2>Cancel {load.reference}?</h2>
            <p className="helpText">
              The load leaves your active queues, its open exceptions are
              closed, and the assigned driver is told not to pick it up.
              Cancelling can&apos;t be undone, so if plans change just book a
              fresh load.
            </p>
            <label>
              Reason
              <input name="reason" required maxLength={500} />
            </label>
            {error && (
              <div className="alert error" role="alert">
                {describe(error)}
              </div>
            )}
            <div className="opsActions">
              <button className="primary" disabled={busy}>
                {busy ? "Cancelling…" : "Cancel this load"}
              </button>
              <button
                type="button"
                className="textButton"
                onClick={() => setMode(null)}
              >
                Keep load
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </>
  );
}
