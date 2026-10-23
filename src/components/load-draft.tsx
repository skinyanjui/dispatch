"use client";
import { useEffect, useState } from "react";
import { ApiError, useApi } from "@/lib/client-api";
import { ErrorAlert } from "@/components/ui/feedback";

type Template = { id: string; name: string; target: string };

/** Make a draft from a load template without leaving the load. */
export function LoadDraft({
  loadId,
  offline,
  onAuthError,
  onOpen,
}: {
  loadId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
  onOpen: (draftId: string) => void;
}) {
  const api = useApi();
  const [templates, setTemplates] = useState<Template[] | null>(null),
    [pick, setPick] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<{ templates: Template[] }>("document-templates")
      .then((r) => {
        if (!live) return;
        const mine = r.templates.filter((t) => t.target === "load");
        setTemplates(mine);
        setPick(mine[0]?.id ?? "");
      })
      .catch(() => live && setTemplates([]));
    return () => {
      live = false;
    };
  }, [api]);
  if (!templates?.length) return null;
  return (
    <section className="loadDraft" aria-label="Draft a document">
      <h3>Draft a document</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const made = await api<{ id: string }>("drafts/generate", {
              template_id: pick,
              target_id: loadId,
              idempotency_key: crypto.randomUUID(),
            });
            onOpen(made.id);
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) onAuthError(err);
            setError(
              err instanceof Error ? err.message : "SERVICE_UNAVAILABLE",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          <span className="srOnly">Template</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" disabled={busy || offline}>
          {busy ? "Drafting…" : "Create draft"}
        </button>
      </form>
      <ErrorAlert error={error} />
    </section>
  );
}
