"use client";
import { useRef, useState } from "react";
import { WarningIcon, FlagIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { Load } from "@/lib/contracts";
import { documentLabels, loadDocumentTypes } from "@/lib/compliance";
import {
  exceptionStatusLabels,
  exceptionTypeLabels,
  exceptionTypes,
  type ExceptionSuggestion,
  type LoadException,
} from "@/lib/exception-rules";

export function when(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
export function severityClass(severity: string) {
  return severity === "high" ? "bad" : severity === "medium" ? "warn" : "";
}
/** `datetime-local` value interpreted in the browser's own time zone. */
function localToIso(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function ExceptionCard({
  item,
  owners,
  manage,
  disabled,
  run,
  now,
}: {
  now: number;
  item: LoadException;
  owners: { id: string; name: string; role: string }[];
  manage: boolean;
  disabled: boolean;
  run: (body: Record<string, unknown>, message: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"" | "resolve" | "reopen">("");
  const overdue =
    item.status !== "resolved" && item.due_at && Date.parse(item.due_at) < now;
  return (
    <article
      className="opsCard"
      aria-label={`${exceptionTypeLabels[item.type]} exception: ${item.summary}`}
    >
      <div className="opsCardHeading">
        <WarningIcon size={16} aria-hidden="true" />
        <h3>{item.summary}</h3>
        <span className={"opsPill " + severityClass(item.severity)}>
          {item.severity}
        </span>
        <span
          className={"opsPill " + (item.status === "resolved" ? "good" : "")}
        >
          {exceptionStatusLabels[item.status]}
        </span>
      </div>
      <p className="opsMeta">
        {exceptionTypeLabels[item.type]}
        {item.document_type && <> · {documentLabels[item.document_type]}</>} ·
        Opened by {item.opened_by_name} {when(item.opened_at)} · Owner{" "}
        {item.owner_name || "unassigned"}
        {item.due_at && (
          <>
            {" "}
            · Due {when(item.due_at)}
            {overdue && <strong> (overdue)</strong>}
          </>
        )}
      </p>
      {item.details && <p className="opsMeta">{item.details}</p>}
      {item.resolution && (
        <p className="opsMeta">
          Resolved by {item.resolved_by_name}: “{item.resolution}”
        </p>
      )}
      {manage && item.status !== "resolved" && (
        <div className="opsActions">
          <label>
            <span className="srOnly">Owner for {item.summary}</span>
            <select
              value={item.owner_id || ""}
              disabled={disabled}
              onChange={(e) =>
                void run(
                  {
                    action: "assign",
                    version: item.version,
                    owner_id: e.target.value || null,
                  },
                  "Exception owner updated.",
                )
              }
            >
              <option value="">Unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          {item.status === "open" && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() =>
                void run(
                  { action: "start", version: item.version },
                  "Exception marked in progress.",
                )
              }
            >
              Start work
            </button>
          )}
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => setMode("resolve")}
          >
            Resolve
          </button>
        </div>
      )}
      {manage && item.status === "resolved" && !mode && (
        <button
          className="textButton"
          disabled={disabled}
          onClick={() => setMode("reopen")}
        >
          Reopen
        </button>
      )}
      {mode && (
        <form
          className="opsForm"
          onSubmit={async (e) => {
            e.preventDefault();
            const text = String(new FormData(e.currentTarget).get("text"));
            const ok = await run(
              mode === "resolve"
                ? { action: "resolve", version: item.version, resolution: text }
                : { action: "reopen", version: item.version, reason: text },
              mode === "resolve"
                ? "Exception resolved."
                : "Exception reopened.",
            );
            if (ok) setMode("");
          }}
        >
          <label>
            {mode === "resolve" ? "How was it resolved?" : "Why reopen?"}
            <input name="text" required maxLength={1000} />
          </label>
          <div className="opsActions">
            <button className="primary" disabled={disabled}>
              {mode === "resolve" ? "Resolve exception" : "Reopen exception"}
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setMode("")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

export function LoadExceptions({
  load,
  role,
  disabled,
  onChanged,
}: {
  load: Load;
  role: string | undefined;
  disabled: boolean;
  onChanged: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const manage = role === "dispatcher" || role === "carrier-manager";
  const [draft, setDraft] = useState<ExceptionSuggestion | null>(null),
    [type, setType] = useState("delay"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now] = useState(() => Date.now());
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const exceptions = load.exceptions || [];
  const suggestions = load.exception_suggestions || [];
  async function run(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError("");
    try {
      const { exception_id, ...payload } = body;
      await api("exceptions/" + exception_id, payload);
      await onChanged(message);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function flag(suggestion: ExceptionSuggestion | null) {
    attempt.current = null;
    setError("");
    setType(suggestion?.type || "delay");
    setDraft(
      suggestion || {
        type: "delay",
        severity: "medium",
        summary: "",
        document_type: null,
      },
    );
  }
  return (
    <div className="loadExceptions">
      <div className="checkInHeading">
        <h3>Exceptions</h3>
        {!draft && (
          <button
            className="secondary"
            disabled={disabled || busy}
            onClick={() => flag(null)}
          >
            <FlagIcon size={14} aria-hidden="true" />
            Flag exception
          </button>
        )}
      </div>
      {suggestions.length > 0 && !draft && (
        <div className="opsList" aria-label="Suggested exceptions">
          {suggestions.map((s) => (
            <div className="opsCard suggestion" key={s.summary}>
              <p className="opsMeta">
                <strong>Check:</strong> {s.summary}. Based on recorded
                milestones, appointments and documents.
              </p>
              <button
                className="secondary"
                disabled={disabled || busy}
                onClick={() => flag(s)}
              >
                Flag this
              </button>
            </div>
          ))}
        </div>
      )}
      {draft && (
        <form
          className="opsForm"
          aria-label="Flag exception"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body: Record<string, unknown> = {
              type: f.get("type"),
              severity: f.get("severity"),
              summary: f.get("summary"),
              details: f.get("details") || "",
            };
            if (body.type === "missing_document")
              body.document_type = f.get("document_type");
            if (manage && f.get("owner_id")) body.owner_id = f.get("owner_id");
            if (manage && f.get("due_at"))
              body.due_at = localToIso(String(f.get("due_at")));
            const signature = JSON.stringify(body);
            if (attempt.current?.signature !== signature)
              attempt.current = { signature, key: crypto.randomUUID() };
            setBusy(true);
            setError("");
            try {
              await api("loads/" + load.id + "/exceptions", {
                ...body,
                idempotency_key: attempt.current.key,
              });
              attempt.current = null;
              setDraft(null);
              await onChanged("Exception flagged.");
            } catch (err) {
              setError(
                err instanceof ApiError ? err.message : "SERVICE_UNAVAILABLE",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="formGrid">
            <label>
              Type
              <select
                name="type"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {exceptionTypes.map((t) => (
                  <option key={t} value={t}>
                    {exceptionTypeLabels[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Severity
              <select name="severity" defaultValue={draft.severity}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
          {type === "missing_document" && (
            <label>
              Document
              <select
                name="document_type"
                defaultValue={draft.document_type || "pod"}
              >
                {loadDocumentTypes.map((t) => (
                  <option key={t} value={t}>
                    {documentLabels[t]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Summary
            <input
              name="summary"
              required
              maxLength={200}
              defaultValue={draft.summary}
            />
          </label>
          <label>
            Details <small>(optional)</small>
            <textarea name="details" maxLength={1000} rows={2} />
          </label>
          {manage && (
            <div className="formGrid">
              <label>
                Owner
                <select name="owner_id" defaultValue="">
                  <option value="">Unassigned</option>
                  {(load.exception_owners || []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Due <small>(your local time)</small>
                <input name="due_at" type="datetime-local" />
              </label>
            </div>
          )}
          <div className="opsActions">
            <button className="primary" disabled={disabled || busy}>
              {busy ? "Saving…" : "Flag exception"}
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
      {error && (
        <p className="alert error" role="alert">
          {describe(error)}
        </p>
      )}
      {exceptions.length ? (
        <div className="opsList">
          {exceptions.map((item) => (
            <ExceptionCard
              key={item.id}
              item={item}
              now={now}
              owners={load.exception_owners || []}
              manage={manage}
              disabled={disabled || busy}
              run={(body, message) =>
                run({ ...body, exception_id: item.id }, message)
              }
            />
          ))}
        </div>
      ) : (
        <p className="helpText">No exceptions recorded for this load.</p>
      )}
    </div>
  );
}
