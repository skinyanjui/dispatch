"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpIcon, PlusIcon, SparkleIcon } from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import {
  examplePrompts,
  type AssistantState,
  type AssistantTurn,
  type Conversation,
  type Source,
} from "@/lib/assistant-types";
import { ErrorAlert } from "@/components/ui/feedback";

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
    <div className="asstAnswer">
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
    <div className="asstSources" role="group" aria-label="Sources">
      <small>Based on</small>
      {sources.slice(0, 12).map((s) => (
        <button
          key={s.kind + s.id}
          type="button"
          className="asstChip"
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
  const box = useRef<HTMLTextAreaElement>(null);
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
  // The box grows with its text, up to a limit, and shrinks after sending.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [draft, state?.enabled]);
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
  const history = (state?.conversations ?? []).filter((c) =>
    c.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section className="assistant" aria-label="Assistant">
      <h2 className="srOnly">Assistant</h2>
      {loadError && (
        <ErrorAlert error={loadError} onRetry={() => void loadState()} />
      )}
      {state && !state.enabled && (
        <div className="asstOff">
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
          <ErrorAlert error={error} />
        </div>
      )}
      {state?.enabled && (
        <div className="asstLayout">
          <aside className="asstHistory" aria-label="Conversations">
            <button
              type="button"
              className="secondary asstNew"
              onClick={() => void pick("")}
            >
              <PlusIcon size={14} aria-hidden="true" />
              New chat
            </button>
            {history.length > 0 && (
              <ul>
                {history.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="asstHistoryItem"
                      aria-current={conversation?.id === c.id || undefined}
                      onClick={() => void pick(c.id)}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          <div className="asstMain">
            <div className="asstBar">
              <label>
                <span className="srOnly">Conversation</span>
                <select
                  value={conversation?.id ?? ""}
                  onChange={(e) => void pick(e.target.value)}
                >
                  <option value="">New conversation</option>
                  {history.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div
              className="asstThread"
              role="log"
              aria-label="Conversation"
              aria-live="polite"
            >
              {!turns.length && !pending && (
                <div className="asstStart">
                  <span className="asstMark" aria-hidden="true">
                    <SparkleIcon size={22} weight="fill" />
                  </span>
                  <h3>What can I help with?</h3>
                  <p>
                    I read your loads, exceptions, billing, prospects, contacts
                    and carriers. I send nothing and change nothing.
                  </p>
                  <div className="asstExamples">
                    {examplePrompts.map((p) => (
                      <button
                        key={p}
                        type="button"
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
                <div key={t.id} className="asstTurn">
                  <p className="asstUser">{t.question}</p>
                  <div className="asstReply">
                    <span className="asstAvatar" aria-hidden="true">
                      <SparkleIcon size={14} weight="fill" />
                    </span>
                    <div className="asstBody">
                      {t.status === "succeeded" && t.answer ? (
                        <>
                          <Answer text={t.answer} />
                          <Sources sources={t.sources} onOpen={onOpen} />
                        </>
                      ) : (
                        <ErrorAlert>
                          {failureText[t.error_code ?? ""] ??
                            "That question couldn't be answered."}
                        </ErrorAlert>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {pending && (
                <div className="asstTurn">
                  <p className="asstUser">{pending.question}</p>
                  <div className="asstReply">
                    <span className="asstAvatar" aria-hidden="true">
                      <SparkleIcon size={14} weight="fill" />
                    </span>
                    <p className="asstWorking" role="status">
                      Looking through your records
                      <span className="asstDots" aria-hidden="true" />
                    </p>
                  </div>
                </div>
              )}
              <div ref={end} />
            </div>
            <div className="asstDock">
              {error && (
                <ErrorAlert>
                  {describe(error)}
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void submit(attempt.current?.question ?? draft)
                    }
                  >
                    Try again
                  </button>
                </ErrorAlert>
              )}
              <form
                className="asstComposer"
                aria-label="Ask the assistant"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(draft);
                }}
              >
                <label>
                  <span className="srOnly">Your question</span>
                  <textarea
                    ref={box}
                    rows={1}
                    maxLength={2000}
                    value={draft}
                    placeholder="Ask about a load, a carrier, an invoice or a prospect"
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
                  className="asstSend"
                  aria-label="Ask"
                  disabled={busy || offline || !draft.trim()}
                >
                  <ArrowUpIcon size={16} weight="bold" aria-hidden="true" />
                </button>
              </form>
              <small className="asstNote">
                {state.provider?.name === "fixture"
                  ? "Sample answers from fixed rules. No AI is used."
                  : "Answers come from your records through an AI model. Check anything important before you act on it."}
              </small>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
