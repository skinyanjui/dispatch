"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, useApi } from "@/lib/client-api";
import { ErrorAlert } from "@/components/ui/feedback";
import type { WorkspaceFilters } from "@/lib/routes";
type Job = {
  id: string;
  status: string;
  row_count: number | null;
  error_code: string | null;
  created_at?: string;
};
/** Waiting this long without a result is worth saying so. */
const slowAfterMs = 2 * 60 * 1000;
export function ReportExports({
  scope,
  from,
  to,
  carrier,
  disabled,
  onScopeChange,
  onAuthError,
}: {
  scope: WorkspaceFilters;
  from: string;
  to: string;
  carrier: string;
  disabled: boolean;
  onScopeChange?: (scope: WorkspaceFilters) => void;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi(),
    pending = useRef<{ signature: string; key: string } | null>(null);
  const [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [slow, setSlow] = useState(false),
    [error, setError] = useState("");
  const id = scope.export_id;
  useEffect(() => {
    if (!id) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Job>("reports/exports/" + id);
        if (!active) return;
        setJob(next);
        const waiting = next.status === "queued" || next.status === "running";
        setSlow(
          waiting &&
            !!next.created_at &&
            Date.now() - Date.parse(next.created_at) > slowAfterMs,
        );
        if (waiting) timer = setTimeout(poll, 2500);
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, id, onAuthError]);
  async function prepare() {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    const filters = { from, to, ...(carrier ? { carrier_id: carrier } : {}) },
      signature = JSON.stringify(filters);
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: crypto.randomUUID() };
    try {
      const next = await api<{ id: string }>("reports/exports", {
        ...filters,
        key: pending.current.key,
      });
      pending.current = null;
      setJob({
        id: next.id,
        status: "queued",
        row_count: null,
        error_code: null,
      });
      onScopeChange?.({ ...scope, export_id: next.id });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="setupOptional">
      <summary>Larger exports</summary>
      <p className="helpText">
        Direct downloads support up to 50,000 loads. Prepare larger exports in
        the background, up to 500,000 loads or 64 MB of CSV. Files expire after
        24 hours; no partial download is offered.
      </p>
      <button
        className="secondary"
        disabled={disabled || busy}
        onClick={() => void prepare()}
      >
        {busy ? "Requesting…" : "Prepare larger export"}
      </button>
      <ErrorAlert error={error || job?.error_code} />
      {job && (
        <p role="status">
          {job.status === "ready"
            ? `${job.row_count} rows prepared. Ready to download.`
            : job.status === "failed"
              ? "Export failed. No partial file is available. Narrow the range and prepare again."
              : "Export queued or running. This page will update when it is ready."}
        </p>
      )}
      {job && slow && (
        <p className="helpText">
          This is taking longer than expected. You can keep this page open or
          come back later; the export stays available for 24 hours. If it never
          starts it is marked failed, and you can prepare it again.
        </p>
      )}
      {job?.status === "ready" && (
        <a
          className="secondary"
          href={"/api/reports/exports/" + job.id + "/download"}
          download
        >
          Download complete export
        </a>
      )}
    </details>
  );
}
