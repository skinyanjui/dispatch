"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PaperPlaneTiltIcon, SparkleIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import {
  examplePrompts,
  type AssistantState,
  type AssistantTurn,
  type Conversation,
  type Source,
} from "@/lib/assistant-types";

type Pending = { question: string; key: string };
const failureText: Record<string, string> = {
  PROVIDER_UNAVAILABLE:
    "The assistant couldn't be reached. Nothing was changed. Try again.",
  PROVIDER_REFUSED: "The assistant declined to answer that.",
  PROVIDER_INVALID_OUTPUT: "The answer didn't look right, so it wasn't shown.",
  TIMED_OUT: "That took too long. Try again.",
};

/** Answers are plain text; lines starting with a bullet become a list. */
function Answer({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const item = /^\s*(?:[•\-*]|\d+\.)\s+(.*)$/.exec(line);
    const list = item !== null;
    const last = blocks.at(-1);
    if (last && last.list === list) last.lines.push(item ? item[1] : line);
    else blocks.push({ list, lines: [item ? item[1] : line] });
  }
  return (
    <div className="assistantAnswer">
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>{l}</li>
            ))}
          </ul>
        ) : (
          b.lines.map((l, j) => <p key={i + "-" + j}>{l}</p>)
        ),
      )}
    </div>
  );
}

function Sources({
  sources,
  onOpen,
}: {
  sources: Source[];
  onOpen: (source: Source) => void;
}) {
  if (!sources.length) return null;
  return (
    <div className="assistantSources" role="group" aria-label="Sources">
      <small>Based on</small>
      {sources.slice(0, 12).map((s) => (
        <button
          key={s.kind + s.id}
          type="button"
          className="attentionChip"
          onClick={() => onOpen(s)}
        >
          {s.label}
        </button>
      ))}
      {sources.length > 12 && <small>and {sources.length - 12} more</small>}
    </div>
  );
}

export function Assistant({
  offline,
  isAdmin,
  onAuthError,
  onOpen,
  query = "",
}: {
  /** Search text from the page header; filters past conversations. */
  query?: string;
  offline: boolean;
  isAdmin: boolean;
  onAuthError: (e: unknown) => void;
  onOpen: (source: Source) => void;
}) {
  const api = useApi();
  const [state, setState] = useState<AssistantState | null>(null),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [pending, setPending] = useState<Pending | null>(null),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false);
  const attempt = useRef<Pending | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      return e instanceof Error ? e.message : "SERVICE_UNAVAILABLE";
    },
    [onAuthError],
  );
  const loadState = useCallback(
    () =>
      api<AssistantState>("assistant")
        .then((s) => {
          setState(s);
          setLoadError("");
        })
        .catch((e) => setLoadError(fail(e))),
    [api, fail],
  );
  useEffect(() => {
    void loadState();
  }, [loadState]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [conversation?.turns.length, pending]);

  async function submit(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    // One retry identity per unchanged question.
    if (attempt.current?.question !== text)
      attempt.current = { question: text, key: crypto.randomUUID() };
    const sending = attempt.current;
    setPending(sending);
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        conversation_id: string;
        turn: AssistantTurn;
      }>(
        "assistant/ask",
        {
          question: text,
          ...(conversation ? { conversation_id: conversation.id } : {}),
        },
        sending.key,
      );
      attempt.current = null;
      setDraft("");
      setConversation((old) => ({
        id: result.conversation_id,
        title: old?.title ?? text.slice(0, 80),
        turns: [...(old?.turns ?? []), result.turn],
      }));
      void loadState();
    } catch (e) {
      setError(fail(e));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }
  async function turnOn() {
    setBusy(true);
    setError("");
    try {
      const org = state!.organization_id;
      const current = await api<{
        enabled: boolean;
        monthly_limit_cents: number;
        version: number;
      }>(`organizations/${org}/ai`);
      await api(`organizations/${org}/ai`, {
        version: current.version,
        enabled: current.enabled,
        assistant_enabled: true,
        monthly_limit_cents: current.monthly_limit_cents,
      });
      await loadState();
    } catch (e) {
      setError(fail(e));
    } finally {
      setBusy(false);
    }
  }
  async function pick(id: string) {
    setError("");
    if (!id) return setConversation(null);
    try {
      setConversation(await api<Conversation>("assistant/conversations/" + id));
    } catch (e) {
      setError(fail(e));
    }
  }

  const turns = conversation?.turns ?? [];
  return (
    <section className="carrierDirectory assistant" aria-label="Assistant">
      <div className="directoryIntro">
        <div>
          <h2>Assistant</h2>
          <p>
            Ask about loads, exceptions, billing, prospects, contacts and
            carriers. It reads your records and can&apos;t change anything.
          </p>
        </div>
        {state?.enabled && (state.conversations.length > 0 || conversation) && (
          <div className="directoryControls">
            <label>
              <span className="srOnly">Conversation</span>
              <select
                value={conversation?.id ?? ""}
                onChange={(e) => void pick(e.target.value)}
              >
                <option value="">New conversation</option>
                {state.conversations
                  .filter((c) =>
                    c.title.toLowerCase().includes(query.trim().toLowerCase()),
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {loadError && (
        <div className="alert error" role="alert">
          {describe(loadError)}
          <button className="secondary" onClick={() => void loadState()}>
            Retry
          </button>
        </div>
      )}
      {state && !state.enabled && (
        <div className="directoryEmpty">
          <SparkleIcon size={32} weight="light" aria-hidden="true" />
          <h3>The assistant is off</h3>
          {isAdmin ? (
            <>
              <p>
                Turning it on lets staff ask questions. What it looks up for a
                question is sent to the model provider, and spending counts
                toward your monthly AI limit.
              </p>
              <button
                className="primary"
                disabled={busy || offline || !state.available}
                onClick={() => void turnOn()}
              >
                Turn on the assistant
              </button>
              {!state.available && (
                <small>
                  This server has no model account yet, so it can&apos;t be
                  turned on.
                </small>
              )}
            </>
          ) : (
            <p>An owner or admin of your organization can turn it on.</p>
          )}
          {error && (
            <p className="alert error" role="alert">
              {describe(error)}
            </p>
          )}
        </div>
      )}
      {state?.enabled && (
        <>
          <div
            className="assistantThread"
            role="log"
            aria-label="Conversation"
            aria-live="polite"
          >
            {!turns.length && !pending && (
              <div className="assistantStart">
                <p>Try one of these:</p>
                <div className="assistantExamples">
                  {examplePrompts.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="attentionChip"
                      disabled={busy || offline}
                      onClick={() => void submit(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t) => (
              <div key={t.id} className="assistantTurn">
                <p className="assistantQuestion">{t.question}</p>
                {t.status === "succeeded" && t.answer ? (
                  <>
                    <Answer text={t.answer} />
                    <Sources sources={t.sources} onOpen={onOpen} />
                  </>
                ) : (
                  <p className="alert error">
                    {failureText[t.error_code ?? ""] ??
                      "That question couldn't be answered."}
                  </p>
                )}
              </div>
            ))}
            {pending && (
              <div className="assistantTurn">
                <p className="assistantQuestion">{pending.question}</p>
                <p className="helpText" role="status">
                  Looking through your records…
                </p>
              </div>
            )}
            <div ref={end} />
          </div>
          {error && (
            <div className="alert error" role="alert">
              {describe(error)}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void submit(attempt.current?.question ?? draft)}
              >
                Try again
              </button>
            </div>
          )}
          <form
            className="assistantComposer"
            aria-label="Ask the assistant"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(draft);
            }}
          >
            <label>
              <span className="srOnly">Your question</span>
              <textarea
                rows={2}
                maxLength={2000}
                value={draft}
                placeholder="Ask about a load, a carrier, an invoice or a prospect…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit(draft);
                  }
                }}
              />
            </label>
            <button
              className="primary"
              disabled={busy || offline || !draft.trim()}
            >
              <PaperPlaneTiltIcon size={15} aria-hidden="true" />
              Ask
            </button>
          </form>
          <small className="assistantNote">
            {state.provider?.name === "fixture"
              ? "Sample answers from fixed rules. No AI is used."
              : "Answers come from your records through an AI model. Check anything important before you act on it."}
          </small>
        </>
      )}
    </section>
  );
}
