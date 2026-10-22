"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, describe, useApi } from "@/lib/client-api";

type Note = {
  id: string;
  body: string;
  created_at: string;
  author_name: string;
};
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Internal notes for the dispatch team on one load; drivers never see them. */
export function LoadNotes({
  loadId,
  offline,
  onAuthError,
}: {
  loadId: string;
  offline: boolean;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [notes, setNotes] = useState<Note[] | null>(null),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  // One identity per unchanged note, so a retry after a lost reply is safe.
  const key = useRef<{ body: string; id: string } | null>(null);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      return e instanceof Error ? e.message : "SERVICE_UNAVAILABLE";
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    try {
      setNotes((await api<{ notes: Note[] }>(`loads/${loadId}/notes`)).notes);
      setError("");
    } catch (e) {
      setError(fail(e));
    }
  }, [api, loadId, fail]);
  useEffect(() => {
    // Fetch per load; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    if (key.current?.body !== body)
      key.current = { body, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await api(`loads/${loadId}/notes`, {
        body,
        idempotency_key: key.current.id,
      });
      key.current = null;
      setText("");
      setStatus("Note added.");
      await load();
    } catch (err) {
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="loadNotes" aria-label="Internal notes">
      <h3>Notes</h3>
      <p className="helpText">
        Only your dispatch team and the carrier&apos;s managers see these.
        Drivers do not.
      </p>
      <form onSubmit={submit} aria-label="Add a note">
        <label>
          <span className="srOnly">Note</span>
          <textarea
            rows={2}
            maxLength={2000}
            value={text}
            placeholder="What should the next person know? Ctrl or ⌘ + Enter adds it."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter")
                e.currentTarget.form?.requestSubmit();
            }}
          />
        </label>
        <button
          className="secondary"
          disabled={busy || offline || !text.trim()}
        >
          {busy ? "Adding…" : "Add note"}
        </button>
      </form>
      <p className="srOnly" aria-live="polite">
        {status}
      </p>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button
            type="button"
            className="secondary"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}
      <ul className="noteList" aria-label="Notes">
        {(notes ?? []).map((n) => (
          <li key={n.id}>
            <p>{n.body}</p>
            <small>
              {n.author_name} ·{" "}
              <time dateTime={n.created_at}>{when(n.created_at)}</time>
            </small>
          </li>
        ))}
        {notes && !notes.length && (
          <li>
            <small>No notes yet.</small>
          </li>
        )}
      </ul>
    </section>
  );
}
