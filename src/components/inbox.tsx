"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatTextIcon,
  EnvelopeSimpleIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PhoneIcon,
  PlusIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { DirectoryEntry } from "@/lib/contact-types";

export type Compose = {
  to: DirectoryEntry[];
  subject?: string;
  load?: { id: string; reference: string };
};
type Thread = {
  id: string;
  subject: string;
  unread: boolean;
  message_count: number;
  load_reference: string | null;
  carrier_name: string | null;
  with_names: string[];
  last: {
    channel: Channel;
    direction: "in" | "out";
    source: string;
    preview: string;
    sender: string;
    occurred_at: string;
  } | null;
  last_message_at: string;
};
type Delivery = {
  id: string;
  attempts: number;
  key: string;
  name: string | null;
  channel: string;
  status: string;
  error: string | null;
};
type Message = {
  id: string;
  channel: Channel;
  direction: "in" | "out";
  source: "relay" | "logged";
  body: string;
  counterpart: string;
  occurred_at: string;
  sender_user_id: string;
  sender_name: string;
  attachments?: { id: string; filename: string; size_bytes: number }[];
  deliveries: Delivery[];
};
type ThreadView = {
  id: string;
  subject: string;
  load: { id: string; reference: string } | null;
  participants: {
    key: string;
    name: string;
    email: string;
    phone: string;
    user_id: string | null;
  }[];
  messages: Message[];
};
type Channel = "in_app" | "email" | "sms" | "call";
type SavedReply = {
  id: string;
  title: string;
  body: string;
  shared: boolean;
  mine: boolean;
  owner_name: string;
};
type Mode =
  | "in_app"
  | "email"
  | "sms"
  | "log-call-out"
  | "log-call-in"
  | "log-email-in"
  | "log-email-out"
  | "log-sms-in"
  | "log-sms-out";

const icon = { size: 15, "aria-hidden": true } as const;
export const channelLabels: Record<Channel, string> = {
  in_app: "Relay message",
  email: "Email",
  sms: "Text",
  call: "Call",
};
const deliveryLabels: Record<string, string> = {
  delivered: "Delivered in Relay",
  queued: "Queued",
  pending: "Queued",
  sent: "Handed to provider",
  failed: "Failed",
  unknown: "Outcome unknown — do not resend until you confirm",
  not_sent: "Not sent",
};
const modeLabels: Record<Mode, string> = {
  in_app: "Message in Relay",
  email: "Send email",
  sms: "Send text",
  "log-call-out": "Log call I made",
  "log-call-in": "Log call I received",
  "log-email-in": "Log email received",
  "log-email-out": "Log email I sent elsewhere",
  "log-sms-in": "Log text received",
  "log-sms-out": "Log text I sent elsewhere",
};
const isLog = (m: Mode) => m.startsWith("log-");
const modeParts = (m: Mode) => {
  if (!isLog(m)) return { mode: "send" as const, channel: m as Channel };
  const [, channel, direction] = m.split("-");
  return {
    mode: "log" as const,
    channel: channel as Channel,
    direction: direction as "in" | "out",
  };
};

export function fillReply(
  body: string,
  vars: { name: string; load: string; sender: string },
) {
  return body.replace(
    /\{(name|load|sender)\}/g,
    (_, key: "name" | "load" | "sender") => vars[key],
  );
}
const ChannelIcon = ({ channel }: { channel: Channel }) =>
  channel === "email" ? (
    <EnvelopeSimpleIcon {...icon} />
  ) : channel === "sms" ? (
    <ChatTextIcon {...icon} />
  ) : channel === "call" ? (
    <PhoneIcon {...icon} />
  ) : (
    <TrayIcon {...icon} />
  );
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Composer({
  recipients,
  threadId,
  initialSubject,
  load,
  userName,
  replies,
  disabled,
  staff,
  onSent,
  onAuthError,
  onChooseRecipients,
  onManageReplies,
}: {
  recipients: { key: string; name: string; email: string; phone: string }[];
  threadId?: string;
  initialSubject?: string;
  load?: { id: string; reference: string } | null;
  userName: string;
  replies: SavedReply[];
  disabled: boolean;
  /** Drivers can only message in Relay; email, text and logging are staff tools. */
  staff: boolean;
  onSent: (threadId: string) => void;
  onAuthError: (e: unknown) => void;
  onChooseRecipients?: () => React.ReactNode;
  onManageReplies: () => void;
}) {
  const api = useApi();
  const [mode, setMode] = useState<Mode>("in_app"),
    [subject, setSubject] = useState(initialSubject ?? ""),
    [body, setBody] = useState(""),
    [counterpart, setCounterpart] = useState(""),
    [occurred, setOccurred] = useState(""),
    [files, setFiles] = useState<
      { id: string; filename: string; size_bytes: number }[]
    >([]),
    [uploading, setUploading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // One key per composed message so a retry after a dropped response cannot duplicate it.
  const key = useRef(crypto.randomUUID());
  const log = isLog(mode);
  // Files stay inside Relay: texts and outgoing email cannot carry them.
  const canAttach = mode === "in_app" || log;
  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(list)) {
        if (files.length >= 3) throw new Error("TOO_MANY_FILES");
        const form = new FormData();
        form.set("file", file);
        const saved = await api<{
          id: string;
          filename: string;
          size_bytes: number;
        }>("message-attachments", form);
        setFiles((old) => [...old, saved]);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      setError(err instanceof Error ? err.message : "SERVICE_UNAVAILABLE");
    } finally {
      setUploading(false);
    }
  }
  const limit = mode === "sms" ? 480 : 5000;
  const first = recipients[0];
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const sent = await api<{ thread_id: string }>("messages", {
        idempotency_key: key.current,
        ...(threadId ? { thread_id: threadId } : { subject: subject.trim() }),
        ...(load ? { load_id: load.id } : {}),
        to: recipients.map((r) => r.key),
        body,
        ...(files.length && canAttach
          ? { attachment_ids: files.map((f) => f.id) }
          : {}),
        ...modeParts(mode),
        ...(log && counterpart.trim()
          ? { counterpart: counterpart.trim() }
          : {}),
        ...(log && occurred
          ? { occurred_at: new Date(occurred).toISOString() }
          : {}),
      });
      key.current = crypto.randomUUID();
      setBody("");
      setOccurred("");
      setFiles([]);
      onSent(sent.thread_id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      setError(err instanceof Error ? err.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  const warn =
    mode === "sms" && recipients.some((r) => !r.phone)
      ? "Some recipients have no phone number."
      : mode === "email" && recipients.some((r) => !r.email)
        ? "Some recipients have no email address."
        : "";
  return (
    <form className="composer" onSubmit={submit} aria-label="Write a message">
      {onChooseRecipients?.()}
      {!threadId && (
        <label>
          Subject
          <input
            value={subject}
            maxLength={200}
            required
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
      )}
      <div className="composerRow">
        <label>
          Action
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as Mode);
              key.current = crypto.randomUUID();
            }}
          >
            {(Object.keys(modeLabels) as Mode[])
              .filter((m) => staff || m === "in_app")
              .map((m) => (
                <option key={m} value={m}>
                  {modeLabels[m]}
                </option>
              ))}
          </select>
        </label>
        <label>
          Saved reply
          <select
            value=""
            onChange={(e) => {
              const found = replies.find((r) => r.id === e.target.value);
              if (found)
                setBody(
                  (b) =>
                    (b ? b + "\n" : "") +
                    fillReply(found.body, {
                      name: first?.name.split(" ")[0] ?? "",
                      load: load?.reference ?? "",
                      sender: userName,
                    }),
                );
            }}
          >
            <option value="">
              {replies.length ? "Insert…" : "None saved yet"}
            </option>
            {replies.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
                {r.shared ? " (shared)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="textButton" onClick={onManageReplies}>
          Manage replies
        </button>
      </div>
      {log && (
        <div className="composerRow">
          <label>
            Who you spoke with (optional)
            <input
              value={counterpart}
              maxLength={160}
              onChange={(e) => setCounterpart(e.target.value)}
            />
          </label>
          <label>
            When (optional)
            <input
              type="datetime-local"
              value={occurred}
              onChange={(e) => setOccurred(e.target.value)}
            />
          </label>
        </div>
      )}
      <label>
        {log ? "Notes" : "Message"}
        <textarea
          value={body}
          rows={4}
          required
          maxLength={limit}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {canAttach && (
        <div className="attachRow">
          <label className="secondary attachButton">
            {uploading ? "Uploading…" : "Attach PDF or image"}
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              multiple
              disabled={uploading || files.length >= 3}
              onChange={(e) => {
                void attach(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {files.map((f) => (
            <button
              type="button"
              key={f.id}
              className="chip"
              aria-label={`Remove ${f.filename}`}
              onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
            >
              {f.filename} ×
            </button>
          ))}
        </div>
      )}
      <small>
        {log
          ? "Logging records this on the conversation. Nothing is sent."
          : mode === "email"
            ? "Sent from Relay; replies go to your email address."
            : mode === "sms"
              ? `Only to people who agreed to texts. ${body.length}/${limit}`
              : "Delivered in Relay and shown in their inbox."}
      </small>
      {warn && (
        <small className="inlineNotice" role="status">
          {warn}
        </small>
      )}
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
        </div>
      )}
      <button
        className="primary"
        disabled={
          busy || disabled || !recipients.length || !body.trim() || !first
        }
      >
        {busy ? "Working…" : log ? "Save to log" : "Send"}
      </button>
    </form>
  );
}

function SavedReplies({
  replies,
  canShare,
  onChanged,
  onClose,
  onAuthError,
}: {
  replies: SavedReply[];
  canShare: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [editing, setEditing] = useState<SavedReply | "new" | null>(null),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [shared, setShared] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
      setEditing(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      setError(err instanceof Error ? err.message : "SERVICE_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  function edit(r: SavedReply | "new") {
    setEditing(r);
    setTitle(r === "new" ? "" : r.title);
    setText(r === "new" ? "" : r.body);
    setShared(r === "new" ? false : r.shared);
  }
  return (
    <section className="savedReplies" aria-label="Saved replies">
      <div className="directoryIntro">
        <div>
          <h3>Saved replies</h3>
          <p>
            Use {"{name}"}, {"{load}"} and {"{sender}"} to fill in details when
            inserted.
          </p>
        </div>
        <div className="actionRow">
          <button className="secondary" onClick={() => edit("new")}>
            <PlusIcon {...icon} /> New reply
          </button>
          <button className="textButton" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
        </div>
      )}
      {editing && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              editing === "new"
                ? api("saved-replies", { title, body: text, shared })
                : api(`saved-replies/${editing.id}`, {
                    title,
                    body: text,
                    shared,
                  }),
            );
          }}
        >
          <label>
            Title
            <input
              value={title}
              maxLength={80}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Text
            <textarea
              value={text}
              rows={3}
              maxLength={2000}
              required
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {canShare && (
            <label className="setupCheckbox">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              <span>Share with my organization</span>
            </label>
          )}
          <div className="actionRow">
            <button className="primary" disabled={busy}>
              Save reply
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <ul className="replyList">
        {replies.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.title}</strong>
              <small>
                {r.shared ? `Shared by ${r.owner_name}` : "Only you"}
              </small>
              <p>{r.body}</p>
            </div>
            {r.mine && (
              <div className="actionRow">
                <button
                  className="textButton"
                  disabled={busy}
                  onClick={() => edit(r)}
                >
                  Edit
                </button>
                <button
                  className="textButton"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete “${r.title}”?`))
                      void run(() => api(`saved-replies/${r.id}/delete`, {}));
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
        {!replies.length && (
          <li>
            <small>No saved replies yet.</small>
          </li>
        )}
      </ul>
    </section>
  );
}

export function Inbox({
  userId,
  userName,
  offline,
  staff,
  compose,
  onComposeDone,
  onAuthError,
  onUnreadChanged,
}: {
  userId: string;
  userName: string;
  offline: boolean;
  staff: boolean;
  compose: Compose | null;
  onComposeDone: () => void;
  onAuthError: (e: unknown) => void;
  onUnreadChanged: () => void;
}) {
  const api = useApi();
  const [q, setQ] = useState(""),
    [unreadOnly, setUnreadOnly] = useState(false),
    [channel, setChannel] = useState(""),
    [threads, setThreads] = useState<Thread[] | null>(null),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [view, setView] = useState<ThreadView | null>(null),
    [viewError, setViewError] = useState(""),
    [replies, setReplies] = useState<{
      replies: SavedReply[];
      can_share: boolean;
    }>({ replies: [], can_share: false }),
    [managing, setManaging] = useState(false),
    [newMessage, setNewMessage] = useState<Compose | null>(compose),
    [people, setPeople] = useState<DirectoryEntry[]>([]),
    [find, setFind] = useState(""),
    [status, setStatus] = useState(""),
    [resending, setResending] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      const id = ++request.current;
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(unreadOnly ? { filter: "unread" } : {}),
          ...(channel ? { channel } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const result = await api<{
          threads: Thread[];
          nextCursor: string | null;
        }>("threads?" + params);
        if (id !== request.current) return;
        setThreads((old) =>
          cursor ? [...(old ?? []), ...result.threads] : result.threads,
        );
        setNext(result.nextCursor);
      } catch (e) {
        if (id !== request.current) return;
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [api, q, unreadOnly, channel, onAuthError],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);
  const loadReplies = useCallback(async () => {
    try {
      setReplies(await api("saved-replies"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
    }
  }, [api, onAuthError]);
  useEffect(() => {
    // Fetch once on mount; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReplies();
  }, [loadReplies]);
  // Looking up people for a new conversation.
  useEffect(() => {
    if (!newMessage) return;
    const timer = setTimeout(async () => {
      try {
        const result = await api<{ entries: DirectoryEntry[] }>(
          "contacts?" + new URLSearchParams(find.trim() ? { q: find } : {}),
        );
        setPeople(result.entries.filter((e) => e.key !== "user:" + userId));
      } catch {
        setPeople([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [api, find, newMessage, userId]);
  const openThread = useCallback(
    async (id: string) => {
      setSelected(id);
      setNewMessage(null);
      setViewError("");
      try {
        const result = await api<ThreadView>("threads/" + id);
        setView(result);
        await api(`threads/${id}/read`, {});
        setThreads((old) =>
          old
            ? old.map((t) => (t.id === id ? { ...t, unread: false } : t))
            : old,
        );
        onUnreadChanged();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        setView(null);
        setViewError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      }
    },
    [api, onAuthError, onUnreadChanged],
  );
  const others = useMemo(
    () =>
      (view?.participants ?? []).filter(
        (p, i, all) =>
          p.user_id !== userId &&
          // The same person can be stored under two keys; show and address them once.
          (!p.user_id || all.findIndex((x) => x.user_id === p.user_id) === i),
      ),
    [view, userId],
  );
  async function resend(d: Delivery) {
    if (
      d.status === "unknown" &&
      !window.confirm(
        `The earlier text to ${d.name ?? "this person"} may have arrived. Resend only if you have confirmed it did not. Send again?`,
      )
    )
      return;
    setResending(d.id);
    setViewError("");
    let failure = "";
    try {
      await api(`message-deliveries/${d.id}/resend`, {
        attempt: d.attempts,
        confirm_unknown: d.status === "unknown",
      });
      setStatus("Text sent again.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      failure = e instanceof Error ? e.message : "SERVICE_UNAVAILABLE";
    }
    if (selected) await openThread(selected);
    setResending(null);
    if (failure) setViewError(failure);
  }
  const finish = async (threadId: string) => {
    setStatus("Saved.");
    onComposeDone();
    await load();
    await openThread(threadId);
  };
  return (
    <section className="inbox" aria-label="Inbox">
      <div className="directoryIntro">
        <div>
          <h2>Inbox</h2>
          <p>
            Messages sent from Relay, plus calls, texts and emails you log here.
            Relay does not read your email or phone, so replies from outside
            appear only when you log them.
          </p>
        </div>
        <button
          className="primary"
          disabled={offline}
          onClick={() => {
            setNewMessage({ to: [] });
            setSelected(null);
            setView(null);
          }}
        >
          <NotePencilIcon {...icon} /> New message
        </button>
      </div>
      <p className="srOnly" role="status">
        {status}
      </p>
      {managing && (
        <SavedReplies
          replies={replies.replies}
          canShare={replies.can_share}
          onChanged={loadReplies}
          onClose={() => setManaging(false)}
          onAuthError={onAuthError}
        />
      )}
      <div className="inboxLayout">
        <div className="inboxList">
          <div className="contactFilters">
            <label className="directorySearch">
              <MagnifyingGlassIcon size={16} aria-hidden="true" />
              <span className="srOnly">Search conversations</span>
              <input
                type="search"
                value={q}
                maxLength={100}
                placeholder="Subject, person or text…"
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label>
              <span className="srOnly">Channel</span>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                <option value="">All channels</option>
                {(Object.keys(channelLabels) as Channel[]).map((c) => (
                  <option key={c} value={c}>
                    {channelLabels[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="setupCheckbox">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
              />
              <span>Unread</span>
            </label>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {describe(error)}
              <button className="secondary" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          <ul className="threadList" aria-label="Conversations">
            {(threads ?? []).map((t) => (
              <li key={t.id}>
                <button
                  className={
                    "threadItem" +
                    (selected === t.id ? " active" : "") +
                    (t.unread ? " unread" : "")
                  }
                  aria-current={selected === t.id ? "true" : undefined}
                  onClick={() => void openThread(t.id)}
                >
                  <span className="threadTop">
                    {t.last && <ChannelIcon channel={t.last.channel} />}
                    <strong>{t.subject}</strong>
                    {t.unread && <span className="srOnly">Unread</span>}
                    <time dateTime={t.last_message_at}>
                      {when(t.last_message_at)}
                    </time>
                  </span>
                  <small>
                    {t.with_names.join(", ") || "Just you"}
                    {t.load_reference && ` · ${t.load_reference}`}
                  </small>
                  {t.last && (
                    <small className="threadPreview">
                      {t.last.direction === "in" ? "← " : ""}
                      {t.last.preview}
                    </small>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {loading && <p role="status">Loading conversations…</p>}
          {!loading && threads && !threads.length && !error && (
            <div className="directoryEmpty">
              <TrayIcon size={36} weight="light" aria-hidden="true" />
              <h3>
                {q || unreadOnly || channel
                  ? "No matching conversations"
                  : "No conversations yet"}
              </h3>
              <p>
                Start one with New message, or open Contacts and choose Message.
              </p>
            </div>
          )}
          {next && (
            <button
              className="secondary"
              disabled={loading}
              onClick={() => void load(next)}
            >
              Load more
            </button>
          )}
        </div>
        <div className="inboxDetail">
          {newMessage && (
            <Composer
              key={newMessage.to.map((p) => p.key).join(",") + "|new"}
              recipients={newMessage.to}
              initialSubject={newMessage.subject}
              load={newMessage.load}
              userName={userName}
              replies={replies.replies}
              disabled={offline}
              staff={staff}
              onAuthError={onAuthError}
              onSent={(id) => void finish(id)}
              onManageReplies={() => setManaging(true)}
              onChooseRecipients={() => (
                <fieldset className="recipientPicker">
                  <legend>To</legend>
                  <div className="chipRow">
                    {newMessage.to.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className="chip"
                        aria-label={`Remove ${p.name}`}
                        onClick={() =>
                          setNewMessage({
                            ...newMessage,
                            to: newMessage.to.filter((x) => x.key !== p.key),
                          })
                        }
                      >
                        {p.name} ×
                      </button>
                    ))}
                  </div>
                  <label>
                    <span className="srOnly">Find people</span>
                    <input
                      type="search"
                      value={find}
                      placeholder="Find people to add…"
                      onChange={(e) => setFind(e.target.value)}
                    />
                  </label>
                  <ul className="pickList">
                    {people
                      .filter(
                        (p) => !newMessage.to.some((x) => x.key === p.key),
                      )
                      .slice(0, 6)
                      .map((p) => (
                        <li key={p.key}>
                          <button
                            type="button"
                            className="textButton"
                            disabled={newMessage.to.length >= 25}
                            onClick={() =>
                              setNewMessage({
                                ...newMessage,
                                to: [...newMessage.to, p],
                              })
                            }
                          >
                            Add {p.name} <small>· {p.detail}</small>
                          </button>
                        </li>
                      ))}
                  </ul>
                </fieldset>
              )}
            />
          )}
          {!newMessage && viewError && (
            <div className="alert error" role="alert">
              {describe(viewError)}
            </div>
          )}
          {!newMessage && view && (
            <>
              <header className="threadHeader">
                <h3>{view.subject}</h3>
                <small>
                  With {others.map((p) => p.name).join(", ") || "no one else"}
                  {view.load && ` · Load ${view.load.reference}`}
                </small>
              </header>
              <ol className="messageList" aria-label="Messages">
                {view.messages.map((m) => (
                  <li
                    key={m.id}
                    className={
                      "message " + (m.direction === "in" ? "in" : "out")
                    }
                  >
                    <div className="messageMeta">
                      <ChannelIcon channel={m.channel} />
                      <strong>
                        {m.direction === "in"
                          ? m.counterpart || "Received"
                          : m.sender_user_id === userId
                            ? "You"
                            : m.sender_name}
                      </strong>
                      <span>
                        {channelLabels[m.channel]}
                        {m.source === "logged" && " · logged by hand"}
                      </span>
                      <time dateTime={m.occurred_at}>
                        {when(m.occurred_at)}
                      </time>
                    </div>
                    <p>{m.body}</p>
                    {(m.attachments?.length ?? 0) > 0 && (
                      <ul className="attachments" aria-label="Attachments">
                        {m.attachments!.map((a) => (
                          <li key={a.id}>
                            <a href={`/api/message-attachments/${a.id}`}>
                              {a.filename}
                            </a>
                            <small>
                              {" "}
                              {(a.size_bytes / 1024).toFixed(0)} KB
                            </small>
                          </li>
                        ))}
                      </ul>
                    )}
                    {m.deliveries.length > 0 && (
                      <ul className="deliveries">
                        {m.deliveries.map((d) => (
                          <li
                            key={d.key + d.channel}
                            className={"delivery " + d.status}
                          >
                            {d.name ?? d.key}:{" "}
                            {deliveryLabels[d.status] ?? d.status}
                            {d.error && ` (${d.error})`}
                            {staff &&
                              d.channel === "sms" &&
                              (d.status === "failed" ||
                                d.status === "unknown") && (
                                <button
                                  className="textButton"
                                  disabled={offline || resending === d.id}
                                  onClick={() => void resend(d)}
                                >
                                  {d.status === "unknown"
                                    ? "Check, then resend"
                                    : "Resend"}
                                </button>
                              )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
              <Composer
                key={view.id}
                threadId={view.id}
                recipients={others}
                load={view.load}
                userName={userName}
                replies={replies.replies}
                disabled={offline}
                staff={staff}
                onAuthError={onAuthError}
                onSent={(id) => void finish(id)}
                onManageReplies={() => setManaging(true)}
              />
            </>
          )}
          {!newMessage && !view && !viewError && (
            <div className="directoryEmpty">
              <TrayIcon size={36} weight="light" aria-hidden="true" />
              <h3>Select a conversation</h3>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
