"use client";
import { useRef, useState } from "react";
import {
  CheckCircleIcon,
  InfoIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { formatMoney } from "@/lib/entry";
import {
  extractionChecks,
  extractionFields,
  isExtractable,
  type FieldKind,
  type Recorded,
} from "@/lib/extraction";
import type { DocumentVersion } from "@/lib/compliance";

const shown = (kind: FieldKind, value: string | number | boolean | null) =>
  value === null
    ? "Not found"
    : kind === "cents"
      ? formatMoney(value as number)
      : kind === "flag"
        ? value
          ? "Yes"
          : "No"
        : String(value);
const confidenceText = {
  high: "Clear",
  medium: "Partly unclear",
  low: "Unsure",
} as const;
const failureText: Record<string, string> = {
  PROVIDER_UNAVAILABLE:
    "Claude couldn't be reached. Nothing was changed. Try again in a moment.",
  PROVIDER_REFUSED: "The model declined to read this file.",
  PROVIDER_INVALID_OUTPUT:
    "The answer didn't look right, so it wasn't saved. You can try again.",
  PROVIDER_REJECTED_FILE:
    "This file couldn't be read. It may be damaged or password-protected.",
  TIMED_OUT: "That reading didn't finish. Try again.",
};
const when = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * A reading is advice: values the model found, each with a quote from the
 * file, compared in plain code with what Relay has recorded. Nothing here
 * changes the document, the load or any billing record.
 */
export function DocumentReading({
  version,
  type,
  label,
  recorded,
  disabled,
  onChanged,
}: {
  version: DocumentVersion;
  type: string;
  label: string;
  recorded: Recorded;
  disabled: boolean;
  onChanged: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // One identity per ask, so an uncertain network failure can be retried
  // without paying for a second reading.
  const key = useRef(crypto.randomUUID());
  const extraction = version.extraction;
  if (!isExtractable(type)) return null;
  if (!extraction && !version.can_read_with_ai) return null;
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    try {
      await onChanged(await fn());
    } catch (e) {
      setError(
        describe(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE"),
      );
    } finally {
      setBusy(false);
    }
  }
  const read = () =>
    run(async () => {
      await api(`documents/${version.id}/read`, {}, key.current);
      key.current = crypto.randomUUID();
      return `${label} was read. Check the values against the file.`;
    });
  const specs = extractionFields[type] as Record<
    string,
    { label: string; kind: FieldKind }
  >;
  const checks =
    extraction?.status === "succeeded" && extraction.fields
      ? extractionChecks(type, extraction.fields, recorded)
      : [];
  return (
    <section className="aiReading" aria-label={`AI reading of ${label}`}>
      {!extraction && (
        <div className="aiAsk">
          <button
            className="secondary"
            disabled={disabled || busy}
            onClick={read}
          >
            <SparkleIcon size={15} aria-hidden="true" />
            {busy ? "Reading…" : "Read with AI"}
          </button>
          <small>
            Sends this file to Claude to suggest values. Nothing is changed.
          </small>
        </div>
      )}
      {extraction?.status === "running" && (
        <p className="helpText" role="status">
          Reading the file…
        </p>
      )}
      {extraction?.status === "failed" && (
        <div className="aiAsk">
          <p className="alert error" role="alert">
            {failureText[extraction.error_code ?? ""] ??
              "The file couldn't be read."}
          </p>
          <button
            className="secondary"
            disabled={disabled || busy}
            onClick={read}
          >
            Try again
          </button>
        </div>
      )}
      {extraction?.status === "succeeded" && extraction.fields && (
        <>
          <p className="aiNote">
            <SparkleIcon size={14} aria-hidden="true" />
            {extraction.provider === "fixture"
              ? "Sample values. No AI was used."
              : `Suggested by ${extraction.model}.`}{" "}
            Check them against the file before relying on them.
          </p>
          <ul className="aiFields" aria-label="Suggested values">
            {Object.entries(extraction.fields).map(([name, s]) => {
              const spec = specs[name];
              if (!spec) return null;
              return (
                <li key={name}>
                  <span className="aiLabel">{spec.label}</span>
                  <strong className={s.value === null ? "aiMissing" : ""}>
                    {shown(spec.kind, s.value)}
                  </strong>
                  {s.value !== null && (
                    <span className={"aiConfidence " + s.confidence}>
                      {confidenceText[s.confidence]}
                    </span>
                  )}
                  {s.quote && <q className="aiQuote">{s.quote}</q>}
                </li>
              );
            })}
          </ul>
          {checks.length > 0 && (
            <ul className="aiChecks" aria-label="Compared with Relay's records">
              {checks.map((c, i) => (
                <li key={i} className={c.level}>
                  {c.level === "ok" ? (
                    <CheckCircleIcon size={16} aria-hidden="true" />
                  ) : c.level === "differs" ? (
                    <WarningCircleIcon size={16} aria-hidden="true" />
                  ) : (
                    <InfoIcon size={16} aria-hidden="true" />
                  )}
                  <span>
                    {c.level === "differs" && (
                      <span className="srOnly">Different: </span>
                    )}
                    {c.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="aiActions">
            {extraction.checked_at ? (
              <small>
                Checked by {extraction.checked_by_name} ·{" "}
                {when(extraction.checked_at)}
              </small>
            ) : (
              <button
                className="secondary"
                disabled={disabled || busy}
                onClick={() =>
                  run(async () => {
                    await api(`extractions/${extraction.id}/check`, {
                      fields: {},
                    });
                    return "Marked as checked.";
                  })
                }
              >
                I checked these
              </button>
            )}
            <button
              className="textButton"
              disabled={disabled || busy}
              onClick={() =>
                run(async () => {
                  await api(`extractions/${extraction.id}/dismiss`, {});
                  return "Reading dismissed. You can read the file again.";
                })
              }
            >
              Dismiss
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
