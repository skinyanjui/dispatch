"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileArrowUpIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { RateDraft } from "@/lib/rate-draft";

export type RateRead = {
  id: string;
  status: "running" | "succeeded" | "failed";
  error_code: string | null;
  filename: string;
  provider: string;
  model: string;
  draft: RateDraft | null;
};
type Status = {
  available: boolean;
  enabled: boolean;
  can_enable: boolean;
  organization_id: string;
  provider: string | null;
};
/** What the Create load form needs to keep from a reading. */
export type FilledDraft = {
  read: RateRead;
  draft: RateDraft;
  file: File;
  /** One identity for attaching the file, stable across retries. */
  attachKey: string;
};

const failureText: Record<string, string> = {
  PROVIDER_UNAVAILABLE:
    "The file couldn't be read just now. Nothing was changed. Try again.",
  PROVIDER_REFUSED: "The model declined to read this file.",
  PROVIDER_INVALID_OUTPUT:
    "The answer didn't look right, so it wasn't used. Try again.",
  PROVIDER_REJECTED_FILE:
    "This file couldn't be read. It may be damaged or password-protected.",
  TIMED_OUT: "That took too long. Try again.",
  MALWARE_DETECTED: "This file was rejected by the malware scan.",
};

/**
 * Starts a load from a broker's rate confirmation: one click to choose the
 * file, and the form below fills in. It only suggests; a person checks every
 * value and creates the load (ADR 0032).
 */
export function RateConfirmationFill({
  carrierId,
  offline,
  filled,
  onFilled,
  onClear,
}: {
  carrierId: string;
  offline: boolean;
  filled: FilledDraft | null;
  onFilled: (filled: FilledDraft) => void;
  onClear: () => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState<Status | null>(null),
    [statusError, setStatusError] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const loadStatus = useCallback(
    () =>
      api<Status>("rate-confirmations/status?carrier_id=" + carrierId)
        .then((s) => {
          setStatus(s);
          setStatusError("");
        })
        .catch((e) =>
          setStatusError(
            e instanceof Error ? e.message : "SERVICE_UNAVAILABLE",
          ),
        ),
    [api, carrierId],
  );
  // The parent keys this component by carrier, so state starts fresh for each.
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function read(file: File) {
    setLastFile(file);
    const signature = [carrierId, file.name, file.size, file.lastModified].join(
      "|",
    );
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("carrier_id", carrierId);
      body.set("idempotency_key", attempt.current.key);
      body.set("file", file);
      const result = await api<RateRead>("rate-confirmations/read", body);
      if (result.status === "succeeded" && result.draft) {
        attempt.current = null;
        onFilled({
          read: result,
          draft: result.draft,
          file,
          attachKey: crypto.randomUUID(),
        });
      } else {
        // A finished failure replays for the same key, so retry with a new one.
        attempt.current = null;
        setError(result.error_code ?? "PROVIDER_UNAVAILABLE");
      }
    } catch (e) {
      // An uncertain network failure keeps its key so a retry cannot pay twice.
      setError(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  async function turnOn() {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      const org = status.organization_id;
      const current = await api<{
        enabled: boolean;
        assistant_enabled?: boolean;
        monthly_limit_cents: number;
        version: number;
      }>(`organizations/${org}/ai`);
      await api(`organizations/${org}/ai`, {
        version: current.version,
        enabled: true,
        assistant_enabled: current.assistant_enabled ?? false,
        monthly_limit_cents: current.monthly_limit_cents,
      });
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  if (statusError)
    return (
      <div className="alert error" role="alert">
        {describe(statusError)}
        <button
          type="button"
          className="secondary"
          onClick={() => void loadStatus()}
        >
          Retry
        </button>
      </div>
    );
  if (!status) return null;
  if (!status.available) return null;
  const message = error ? (failureText[error] ?? describe(error)) : "";
  return (
    <section className="rateFill" aria-label="Fill from a rate confirmation">
      {filled ? (
        <div className="rateFilled" role="status">
          <FileArrowUpIcon size={18} aria-hidden="true" />
          <span>
            <strong>Filled from {filled.read.filename}.</strong> Check each
            highlighted value against the file before creating the load.
            {filled.read.provider === "fixture" &&
              " (Sample values, no AI used.)"}
          </span>
          <button type="button" className="textButton" onClick={onClear}>
            Start over
          </button>
        </div>
      ) : !status.enabled ? (
        <div className="rateOff">
          {status.can_enable ? (
            <button
              type="button"
              className="secondary"
              disabled={busy || offline}
              onClick={() => void turnOn()}
            >
              <FileArrowUpIcon size={15} aria-hidden="true" />
              Turn on AI reading to fill from a rate confirmation
            </button>
          ) : (
            <small>
              AI reading is off for your organization, so rate confirmations
              can&apos;t fill this form.
            </small>
          )}
        </div>
      ) : (
        <div className="rateChoose">
          <button
            type="button"
            className="secondary"
            disabled={busy || offline}
            onClick={() => input.current?.click()}
          >
            <FileArrowUpIcon size={15} aria-hidden="true" />
            {busy ? "Reading the file…" : "Fill from a rate confirmation"}
          </button>
          <input
            ref={input}
            type="file"
            className="srOnly"
            tabIndex={-1}
            aria-label="Rate confirmation file"
            accept="application/pdf,image/png,image/jpeg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void read(file);
            }}
          />
          <small>
            PDF, PNG or JPEG up to 4 MB. It is sent to Claude to suggest values;
            you check them and create the load.
          </small>
        </div>
      )}
      {busy && (
        <p className="helpText" role="status">
          Reading the file…
        </p>
      )}
      {message && (
        <div className="alert error" role="alert">
          {message}
          {lastFile && !filled && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void read(lastFile)}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {filled && filled.draft.notes.length > 0 && (
        <ul className="rateNotes" aria-label="Things to check">
          {filled.draft.notes.map((n) => (
            <li key={n}>
              <WarningCircleIcon size={14} aria-hidden="true" />
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A "check this" line under a form field that came from a reading. */
export function DraftNote({
  draft,
  field,
}: {
  draft: RateDraft | null;
  field: string;
}) {
  const flag = draft?.flags[field];
  const quote = draft?.quotes[field];
  if (!draft || (!flag && !quote)) return null;
  return (
    <span className={"draftNote " + (flag?.level ?? "")}>
      {flag && (
        <>
          <WarningCircleIcon size={13} aria-hidden="true" />
          {flag.message}{" "}
        </>
      )}
      {quote && <q>{quote}</q>}
    </span>
  );
}
