"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ChatTextIcon,
  EnvelopeSimpleIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PhoneIcon,
  PlusIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { Modal } from "@/components/modal";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { DirectoryEntry } from "@/lib/contact-types";
import { formatDateTime } from "@/lib/format";

export type Compose = {
  to: DirectoryEntry[];
  /** Offer this person as the first recipient (e.g. the load's driver). */
  suggest?: { key: string; name: string };
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
  source: "relay" | "logged" | "inbound";
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
export type InboxCounts = {
  unread: number;
  by_channel: Record<Channel, number>;
  archived: number;
  trash: number;
};
type ThreadAction = "unread" | "archive" | "unarchive" | "trash" | "restore";
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
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "•";
/** The Inbox's folders, shown nested under Inbox in the sidebar and as a
 *  rail where the sidebar is collapsed or a sheet. */
export const inboxFolders: Record<string, string> = {
  all: "All",
  unread: "Unread",
  in_app: "Relay",
  email: "Email",
  sms: "Texts",
  call: "Calls",
  archived: "Archived",
  trash: "Trash",
};
export type InboxFolder = keyof typeof inboxFolders;
/** The number beside a folder: unread for channels, a total for Archived and Trash. */
export function folderCount(folder: string, counts: InboxCounts | null) {
  if (!counts || folder === "all") return 0;
  if (folder === "unread") return counts.unread;
  if (folder === "archived") return counts.archived;
  if (folder === "trash") return counts.trash;
  return counts.by_channel[folder as Channel] ?? 0;
}
const when = formatDateTime;

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
  onSent: (threadId: string, logged: boolean) => void;
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
        ...(threadId
          ? { thread_id: threadId }
          : {
              // A subject is a nicety, never a hurdle: make one when it's blank.
              subject:
                subject.trim() ||
                (load ? `About ${load.reference}` : "") ||
                body.trim().replace(/\s+/g, " ").slice(0, 60) ||
                "New conversation",
            }),
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
      onSent(sent.thread_id, log);
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
          Subject <small>(optional, we&apos;ll add one if you skip it)</small>
          <input
            value={subject}
            maxLength={200}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
      )}
      <div className="composerRow">
        {staff ? (
          <div className="composerVia">
            <ToggleGroup
              label="Send via"
              variant="segmented"
              items={[
                { id: "in_app", label: "Relay" },
                { id: "email", label: "Email" },
                { id: "sms", label: "Text" },
              ]}
              value={log ? null : mode}
              onChange={(m) => {
                if (!m) return;
                setMode(m as Mode);
                key.current = crypto.randomUUID();
              }}
            />
            <label className="composerLog">
              <span className="srOnly">Log activity</span>
              <select
                aria-label="Log activity"
                value={log ? mode : ""}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setMode(e.target.value as Mode);
                  key.current = crypto.randomUUID();
                }}
              >
                <option value="">Log activity…</option>
                {(Object.keys(modeLabels) as Mode[]).filter(isLog).map((m) => (
                  <option key={m} value={m}>
                    {modeLabels[m]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        <label className="composerReply">
          <span className="srOnly">Saved reply</span>
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
          placeholder={
            log
              ? "What was said or agreed?"
              : "Write your message. Tip: Ctrl or ⌘ + Enter sends it."
          }
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === "Enter" &&
              body.trim() &&
              recipients.length &&
              !busy
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
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
          <h2>Saved replies</h2>
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
  query,
  folder,
  onFolder,
  onCounts,
}: {
  /** Search text from the page header; without it the page has its own box. */
  query?: string;
  userId: string;
  userName: string;
  offline: boolean;
  staff: boolean;
  compose: Compose | null;
  onComposeDone: () => void;
  onAuthError: (e: unknown) => void;
  onUnreadChanged: () => void;
  /** The open folder; the workspace owns it so the sidebar can switch it. */
  folder: string;
  onFolder: (folder: string) => void;
  onCounts: (counts: InboxCounts) => void;
}) {
  const api = useApi();
  const [ownQ, setQ] = useState(""),
    [counts, setCounts] = useState<InboxCounts | null>(null),
    [undo, setUndo] = useState<{
      id: string;
      undo: ThreadAction;
      text: string;
    } | null>(null),
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
  const q = query ?? ownQ;
  const box: "inbox" | "archived" | "trash" =
    folder === "archived" || folder === "trash" ? folder : "inbox";
  const unreadOnly = folder === "unread";
  const channel = ["in_app", "email", "sms", "call"].includes(folder)
    ? folder
    : "";
  const request = useRef(0);
  const messages = useRef<HTMLOListElement>(null);
  // Open a conversation at its latest message.
  useEffect(() => {
    const list = messages.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [view?.id, view?.messages.length]);
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
          ...(box !== "inbox" ? { view: box } : {}),
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
    [api, q, unreadOnly, channel, box, onAuthError],
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
  const loadCounts = useCallback(async () => {
    try {
      const next = await api<InboxCounts>("threads/counts");
      setCounts(next);
      onCounts(next);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
    }
  }, [api, onAuthError, onCounts]);
  useEffect(() => {
    // Fetch once on mount; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCounts();
  }, [loadCounts]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);
  // Pre-fill the recipient we already know about, so no searching is needed.
  const suggested = newMessage?.suggest;
  useEffect(() => {
    if (!suggested) return;
    let cancelled = false;
    api<{ entries: DirectoryEntry[] }>(
      "contacts?" + new URLSearchParams({ q: suggested.name }),
    )
      .then((r) => {
        const found = r.entries.find((e) => e.key === suggested.key);
        if (!cancelled)
          setNewMessage((m) =>
            m && m.suggest === suggested
              ? { ...m, suggest: undefined, to: found ? [found] : m.to }
              : m,
          );
      })
      .catch(() => undefined); // choosing someone by hand still works
    return () => {
      cancelled = true;
    };
  }, [api, suggested]);
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
  const openRequest = useRef(0);
  const openThread = useCallback(
    async (id: string) => {
      const mine = ++openRequest.current;
      setSelected(id);
      setNewMessage(null);
      setViewError("");
      try {
        const result = await api<ThreadView>("threads/" + id);
        // A slower earlier click must never replace a newer one.
        if (mine !== openRequest.current) return;
        setView(result);
        await api(`threads/${id}/read`, {});
        setThreads((old) =>
          old
            ? old.map((t) => (t.id === id ? { ...t, unread: false } : t))
            : old,
        );
        onUnreadChanged();
        void loadCounts();
      } catch (e) {
        if (mine !== openRequest.current) return;
        if (e instanceof ApiError && e.status === 401) onAuthError(e);
        setView(null);
        setViewError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      }
    },
    [api, onAuthError, onUnreadChanged, loadCounts],
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
  const finish = async (threadId: string, logged = false) => {
    setStatus(logged ? "Saved to the conversation log." : "Message sent.");
    onComposeDone();
    await load();
    await openThread(threadId);
    void loadCounts();
  };
  const inverse: Record<ThreadAction, ThreadAction | null> = {
    unread: null,
    archive: "unarchive",
    unarchive: "archive",
    trash: "restore",
    restore: "trash",
  };
  const doneText: Record<ThreadAction, string> = {
    unread: "Marked as unread.",
    archive: "Conversation archived.",
    unarchive: "Moved back to the inbox.",
    trash: "Moved to trash.",
    restore: "Restored from trash.",
  };
  async function changeState(id: string, action: ThreadAction) {
    setViewError("");
    try {
      await api(`threads/${id}/${action}`, {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setViewError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      return;
    }
    setStatus(doneText[action]);
    setUndo(
      inverse[action]
        ? { id, undo: inverse[action]!, text: doneText[action] }
        : null,
    );
    if (action !== "unread") {
      // It left this list; step back to the list (or the next conversation).
      setThreads((old) => (old ? old.filter((t) => t.id !== id) : old));
      back();
    } else {
      setThreads((old) =>
        old ? old.map((t) => (t.id === id ? { ...t, unread: true } : t)) : old,
      );
      back();
    }
    onUnreadChanged();
    void loadCounts();
  }
  const hasDetail = Boolean(newMessage || view || viewError);
  // A different folder starts from its list, not the open conversation.
  const [shownFolder, setShownFolder] = useState(folder);
  if (shownFolder !== folder) {
    setShownFolder(folder);
    setNewMessage(null);
    setSelected(null);
    setView(null);
  }
  const back = () => {
    setNewMessage(null);
    setSelected(null);
    setView(null);
  };
  return (
    <section className="inbox" aria-label="Inbox">
      <p className="srOnly" role="status">
        {status}
      </p>
      {undo && (
        <div className="undoBar" role="status">
          <span>{undo.text}</span>
          <button
            type="button"
            className="textButton"
            onClick={() => {
              const u = undo;
              setUndo(null);
              void api(`threads/${u.id}/${u.undo}`, {}).then(() => {
                void load();
                void loadCounts();
                onUnreadChanged();
              });
            }}
          >
            Undo
          </button>
        </div>
      )}
      {managing && (
        <Modal label="Saved replies" onClose={() => setManaging(false)}>
          <SavedReplies
            replies={replies.replies}
            canShare={replies.can_share}
            onChanged={loadReplies}
            onClose={() => setManaging(false)}
            onAuthError={onAuthError}
          />
        </Modal>
      )}
      <div className={"inboxLayout hasRail" + (hasDetail ? " hasDetail" : "")}>
        <aside className="inboxRail">
          <ToggleGroup
            label="Filter conversations"
            variant="folders"
            items={Object.keys(inboxFolders).map((f) => {
              const isBox = f === "archived" || f === "trash";
              return {
                id: f,
                label: inboxFolders[f],
                count: folderCount(f, counts),
                className: isBox
                  ? "box" + (f === "archived" ? " firstBox" : "")
                  : undefined,
              };
            })}
            countLabel={(n, item) =>
              `${n} ${item.className ? "conversations" : "unread"}`
            }
            value={folder}
            onChange={(f) => f && onFolder(f)}
          />
        </aside>
        <div className="inboxList">
          <div className="inboxListHead">
            <h3 className="inboxFolderName">{inboxFolders[folder]}</h3>
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
          <label className="directorySearch" hidden={query !== undefined}>
            <MagnifyingGlassIcon size={16} aria-hidden="true" />
            <span className="srOnly">Search conversations</span>
            <input
              type="search"
              value={ownQ}
              maxLength={100}
              placeholder="Search by subject, person or words…"
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          {error && (
            <div className="alert error" role="alert">
              {describe(error)}
              <button className="secondary" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          <ul
            className="threadList"
            aria-label="Conversations"
            onKeyDown={(e) => {
              const focused = document.activeElement as HTMLElement | null;
              const id = focused?.dataset?.threadId;
              if (id && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const action: ThreadAction | null =
                  e.key === "e"
                    ? box === "archived"
                      ? "unarchive"
                      : "archive"
                    : e.key === "#"
                      ? box === "trash"
                        ? "restore"
                        : "trash"
                      : e.key === "u"
                        ? "unread"
                        : null;
                if (action) {
                  e.preventDefault();
                  void changeState(id, action);
                  return;
                }
              }
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const items = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  ".threadItem",
                ),
              ];
              const at = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (at < 0) return;
              e.preventDefault();
              items[
                Math.min(
                  items.length - 1,
                  Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)),
                )
              ]?.focus();
            }}
          >
            {(threads ?? []).map((t) => (
              <li key={t.id}>
                <button
                  data-thread-id={t.id}
                  className={
                    "threadItem" +
                    (selected === t.id ? " active" : "") +
                    (t.unread ? " unread" : "")
                  }
                  aria-current={selected === t.id ? "true" : undefined}
                  onClick={() => void openThread(t.id)}
                >
                  <span className="avatar" aria-hidden="true">
                    {initials(t.with_names[0] ?? userName)}
                  </span>
                  <span className="threadBody">
                    <span className="threadTop">
                      <strong className="threadFrom">
                        {t.with_names.join(", ") || "Just you"}
                      </strong>
                      {t.unread && <span className="srOnly">Unread</span>}
                      <time dateTime={t.last_message_at}>
                        {when(t.last_message_at)}
                      </time>
                    </span>
                    <span className="threadSubject">
                      {t.last && <ChannelIcon channel={t.last.channel} />}
                      <span>{t.subject}</span>
                    </span>
                    {t.last && (
                      <small className="threadPreview">
                        {t.last.direction === "in" ? "← " : ""}
                        {t.last.preview}
                        {t.load_reference && ` · ${t.load_reference}`}
                      </small>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {loading && <p role="status">Loading conversations…</p>}
          {!loading && threads && !threads.length && !error && (
            <div className="directoryEmpty">
              <TrayIcon size={36} weight="light" aria-hidden="true" />
              <h2>
                {box === "archived"
                  ? "Nothing archived"
                  : box === "trash"
                    ? "Trash is empty"
                    : q || unreadOnly || channel
                      ? "No matching conversations"
                      : "Nothing here yet. Let's fix that!"}
              </h2>
              <p>
                {box === "archived"
                  ? "Archived conversations are hidden from your inbox. A new message in one brings it back."
                  : box === "trash"
                    ? "Conversations you move to trash stay here. Messages are never deleted, only hidden from you."
                    : q || unreadOnly || channel
                      ? "Try fewer words or clear the filters."
                      : "Tap New message to say hello, or open Contacts and choose Message next to anyone."}
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
          {hasDetail && (
            <button
              type="button"
              className="backButton textButton"
              onClick={back}
            >
              <ArrowLeftIcon {...icon} /> All conversations
            </button>
          )}
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
              onSent={(id, logged) => void finish(id, logged)}
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
                      placeholder="Type a name to find someone…"
                      onChange={(e) => setFind(e.target.value)}
                      onKeyDown={(e) => {
                        const list = e.currentTarget
                          .closest("fieldset")
                          ?.querySelectorAll<HTMLButtonElement>(
                            ".pickList button",
                          );
                        if (e.key === "ArrowDown" && list?.length) {
                          e.preventDefault();
                          list[0].focus();
                        }
                        if (e.key === "Enter") {
                          // Enter picks the first match instead of submitting.
                          e.preventDefault();
                          list?.[0]?.click();
                        }
                      }}
                    />
                  </label>
                  <ul
                    className="pickList"
                    aria-label="Matching people"
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                      const items = [
                        ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                          "button",
                        ),
                      ];
                      const at = items.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      e.preventDefault();
                      items[
                        Math.max(
                          0,
                          Math.min(
                            items.length - 1,
                            at + (e.key === "ArrowDown" ? 1 : -1),
                          ),
                        )
                      ]?.focus();
                    }}
                  >
                    {(find.trim() ? people : [])
                      .filter(
                        (p) => !newMessage.to.some((x) => x.key === p.key),
                      )
                      .slice(0, 8)
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
                <div>
                  <h2>{view.subject}</h2>
                  <small>
                    With {others.map((p) => p.name).join(", ") || "no one else"}
                    {view.load && ` · Load ${view.load.reference}`}
                  </small>
                </div>
                <div
                  className="threadActions"
                  role="group"
                  aria-label="Conversation actions"
                >
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void changeState(view.id, "unread")}
                  >
                    Mark unread
                  </button>
                  {box !== "trash" && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void changeState(
                          view.id,
                          box === "archived" ? "unarchive" : "archive",
                        )
                      }
                    >
                      {box === "archived" ? "Unarchive" : "Archive"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void changeState(
                        view.id,
                        box === "trash" ? "restore" : "trash",
                      )
                    }
                  >
                    {box === "trash" ? "Restore" : "Move to trash"}
                  </button>
                </div>
              </header>
              <ol className="messageList" aria-label="Messages" ref={messages}>
                {view.messages.map((m) => (
                  <li
                    key={m.id}
                    className={
                      "message " + (m.direction === "in" ? "in" : "out")
                    }
                  >
                    <div className="messageMeta">
                      <span className="avatar small" aria-hidden="true">
                        {initials(
                          m.direction === "in"
                            ? m.counterpart || "Received"
                            : m.sender_user_id === userId
                              ? "You"
                              : m.sender_name,
                        )}
                      </span>
                      <strong>
                        {m.direction === "in"
                          ? m.counterpart || "Received"
                          : m.sender_user_id === userId
                            ? "You"
                            : m.sender_name}
                      </strong>
                      <span className="messageVia">
                        <ChannelIcon channel={m.channel} />
                        {channelLabels[m.channel]}
                        {m.source === "logged" && " · logged by hand"}
                        {m.source === "inbound" && " · received"}
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
                onSent={(id, logged) => void finish(id, logged)}
                onManageReplies={() => setManaging(true)}
              />
            </>
          )}
          {!newMessage && !view && !viewError && (
            <div className="directoryEmpty">
              <TrayIcon size={36} weight="light" aria-hidden="true" />
              <h2>Pick a conversation, or start a new one</h2>
              <p>
                Replies show up by themselves once inbound delivery is set up;
                until then, log them by hand so the whole story stays together.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
