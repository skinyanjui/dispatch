"use client";
import { useCallback, useEffect, useState } from "react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import { dollarsToMinor, formatMoney } from "@/lib/entry";

type Status = {
  available: boolean;
  provider: { name: string; model: string } | null;
  enabled: boolean;
  assistant_enabled: boolean;
  monthly_limit_cents: number;
  spent_cents: number;
  version: number;
};

/** Consent and spend limit for AI document reading (owners and admins). */
export function AiSettings({
  organizationId,
  onAuthError,
}: {
  organizationId: string;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState<Status | null>(null),
    [enabled, setEnabled] = useState(false),
    [assistant, setAssistant] = useState(false),
    [limit, setLimit] = useState("10"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const apply = useCallback((data: Status) => {
    setStatus(data);
    setEnabled(data.enabled);
    setAssistant(data.assistant_enabled);
    setLimit(String(data.monthly_limit_cents / 100));
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(
        describe(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE"),
      );
    },
    [onAuthError],
  );
  useEffect(() => {
    let active = true;
    api<Status>(`organizations/${organizationId}/ai`)
      .then((data) => active && apply(data))
      .catch((e) => active && fail(e));
    return () => {
      active = false;
    };
  }, [api, organizationId, apply, fail]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!status) return;
    setError("");
    setNotice("");
    let cents: number;
    try {
      cents = dollarsToMinor(limit);
    } catch (problem) {
      setError((problem as Error).message);
      return;
    }
    if (cents > 1_000_000) {
      setError("Use $10,000 or less. You can raise it later.");
      return;
    }
    setBusy(true);
    try {
      await api(`organizations/${organizationId}/ai`, {
        version: status.version,
        enabled,
        assistant_enabled: assistant,
        monthly_limit_cents: cents,
      });
      apply(await api<Status>(`organizations/${organizationId}/ai`));
      setNotice(
        enabled
          ? "AI reading is on for this organization."
          : "AI reading is off.",
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="opsCard aiSettings" aria-label="AI document reading">
      <h3>AI document reading</h3>
      <p className="opsMeta">
        Lets dispatchers ask Claude to read an uploaded insurance certificate,
        rate confirmation, bill of lading or proof of delivery and suggest
        values. People check every suggestion. Relay never changes a load,
        document or invoice from it.
      </p>
      <ul className="aiFacts">
        <li>
          Only the file a dispatcher chooses is sent to the model provider.
        </li>
        <li>W-9s and dispatch agreements are never sent.</li>
        <li>Each reading is billed to this server&apos;s model account.</li>
      </ul>
      {status && !status.available && (
        <p className="alert error" role="status">
          Not set up on this server yet: it has no model account. Ask whoever
          runs Relay to add one.
        </p>
      )}
      {status && (
        <form className="opsForm" onSubmit={save}>
          <label className="aiConsent">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || (!status.available && !status.enabled)}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Allow AI reading for this organization</span>
          </label>
          <label className="aiConsent">
            <input
              type="checkbox"
              checked={assistant}
              disabled={
                busy || (!status.available && !status.assistant_enabled)
              }
              onChange={(e) => setAssistant(e.target.checked)}
            />
            <span>Allow the dispatch assistant</span>
          </label>
          <small>
            The assistant answers questions about loads, billing, prospects and
            contacts. It can only read, and what it looks up for a question is
            sent to the model provider.
          </small>
          <label>
            Monthly limit (USD)
            <input
              inputMode="decimal"
              value={limit}
              disabled={busy}
              onChange={(e) => setLimit(e.target.value)}
              aria-describedby="ai-spent"
            />
          </label>
          <small id="ai-spent">
            Used this month: {formatMoney(status.spent_cents)}
            {status.provider && status.provider.name !== "fixture"
              ? ` · model ${status.provider.model}`
              : status.provider
                ? " · sample values, no AI"
                : ""}
          </small>
          <div className="opsActions">
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p className="helpText" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
