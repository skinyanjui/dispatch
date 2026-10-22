"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EnvelopeSimpleIcon,
  MagnifyingGlassIcon,
  PhoneIcon,
  PlusIcon,
  StarIcon,
  ChatTextIcon,
  CopyIcon,
} from "@phosphor-icons/react";
import { ApiError, describe, useApi } from "@/lib/client-api";
import {
  contactKindLabels,
  contactKinds,
  dialable,
  groupLabels,
  type ContactKind,
  type DirectoryEntry,
  type DirectoryGroup,
} from "@/lib/contact-types";

type Directory = {
  entries: DirectoryEntry[];
  truncated: boolean;
  more?: Partial<Record<DirectoryGroup, number>>;
  can_add: boolean;
  carriers: { id: string; name: string; organization_id: string }[];
  manager_carriers: string[];
  organizations: string[];
};

const icon = { size: 15, "aria-hidden": true } as const;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Row({
  entry,
  disabled,
  onFavorite,
  onEdit,
  onMessage,
}: {
  entry: DirectoryEntry;
  disabled: boolean;
  onFavorite: () => void;
  onEdit?: () => void;
  onMessage?: (entry: DirectoryEntry) => void;
}) {
  const [copied, setCopied] = useState("");
  const copy = (value: string, label: string) =>
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    });
  return (
    <article
      className="dirRow"
      aria-label={`${entry.name}, ${entry.detail}`}
    >
      <span className={"dirAvatar " + entry.group} aria-hidden="true">
        {initials(entry.name)}
      </span>
      <div className="dirMain">
        <strong>{entry.name}</strong>
        <small title={entry.carriers.map((c) => c.name).join(", ")}>
          {entry.detail}
          {entry.carriers.length > 0 && " · " + entry.carriers[0].name}
          {entry.carriers.length > 1 && ` +${entry.carriers.length - 1} more`}
        </small>
        <small className="dirLines">
          {entry.phone && <span>{entry.phone}</span>}
          {entry.email && <span>{entry.email}</span>}
          {!entry.phone && !entry.email && <span>No contact details yet</span>}
        </small>
        {entry.notes && <small>{entry.notes}</small>}
        {copied && (
          <small role="status" className="inlineNotice">
            {copied} copied
          </small>
        )}
      </div>
      <div className="dirActions">
        {entry.phone && (
          <a
            className="iconAction"
            href={`tel:${dialable(entry.phone)}`}
            aria-label={`Call ${entry.name}`}
            title="Call"
          >
            <PhoneIcon {...icon} />
          </a>
        )}
        {entry.phone && (
          <a
            className="iconAction"
            href={`sms:${dialable(entry.phone)}`}
            aria-label={`Text ${entry.name}`}
            title="Text from this device"
          >
            <ChatTextIcon {...icon} />
          </a>
        )}
        {entry.email && (
          <a
            className="iconAction"
            href={`mailto:${entry.email}`}
            aria-label={`Email ${entry.name}`}
            title="Email"
          >
            <EnvelopeSimpleIcon {...icon} />
          </a>
        )}
        {onMessage && (entry.email || entry.phone) && (
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => onMessage(entry)}
            aria-label={`Message ${entry.name}`}
          >
            Message
          </button>
        )}
        {(entry.phone || entry.email) && (
          <button
            className="iconAction"
            aria-label={`Copy ${entry.name}'s ${entry.phone ? "phone number" : "email"}`}
            title="Copy"
            onClick={() =>
              entry.phone
                ? copy(entry.phone, "Phone")
                : copy(entry.email, "Email")
            }
          >
            <CopyIcon {...icon} />
          </button>
        )}
        <button
          className={"iconAction" + (entry.favorite ? " starred" : "")}
          disabled={disabled}
          aria-pressed={entry.favorite}
          aria-label={
            entry.favorite
              ? `Remove ${entry.name} from favorites`
              : `Add ${entry.name} to favorites`
          }
          onClick={onFavorite}
        >
          <StarIcon {...icon} weight={entry.favorite ? "fill" : "regular"} />
        </button>
        {onEdit && (
          <button className="secondary" disabled={disabled} onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
    </article>
  );
}

export function ContactsDirectory({
  offline,
  onAuthError,
  onMessage,
  query,
  onClearQuery,
}: {
  offline: boolean;
  onAuthError: (e: unknown) => void;
  onMessage?: (entry: DirectoryEntry) => void;
  /** Search text from the page header; without it the page has its own box. */
  query?: string;
  onClearQuery?: () => void;
}) {
  const api = useApi();
  const [ownQ, setQ] = useState(""),
    [group, setGroup] = useState<"" | DirectoryGroup>(""),
    [carrier, setCarrier] = useState(""),
    [favorites, setFavorites] = useState(false),
    [data, setData] = useState<Directory | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editing, setEditing] = useState<DirectoryEntry | "new" | null>(null),
    [busy, setBusy] = useState(false);
  const q = query ?? ownQ;
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(group ? { group } : {}),
        ...(carrier ? { carrier_id: carrier } : {}),
        ...(favorites ? { favorites: "true" } : {}),
      });
      const result = await api<Directory>("contacts?" + params);
      if (id === request.current) setData(result);
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [api, q, group, carrier, favorites, onAuthError]);
  useEffect(() => {
    // Debounced fetch as filters change; state is set after the response.
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);
  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      if (message) setNotice(message);
      await load();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const entries = data?.entries ?? [];
  const starred =
    !q && !group && !favorites ? entries.filter((e) => e.favorite) : [];
  return (
    <section className="carrierDirectory" aria-label="Contacts">
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Contacts</h2>
          <p className="dirNote">
            Tap call, text or email to reach out from this device, or Message to
            keep it in Relay.
          </p>
        </div>
        {data?.can_add && (
          <button
            className="primary"
            disabled={offline || busy}
            onClick={() => setEditing("new")}
          >
            <PlusIcon {...icon} weight="bold" />
            Add contact
          </button>
        )}
      </div>
      <div className="contactFilters">
        <label className="directorySearch" hidden={query !== undefined}>
          <MagnifyingGlassIcon size={16} aria-hidden="true" />
          <span className="srOnly">Search contacts</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, company, email or phone…"
            maxLength={100}
          />
        </label>
        <label>
          <span className="srOnly">Type</span>
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value as "" | DirectoryGroup)}
          >
            <option value="">Everyone</option>
            {(Object.keys(groupLabels) as DirectoryGroup[]).map((g) => (
              <option key={g} value={g}>
                {groupLabels[g]}
              </option>
            ))}
          </select>
        </label>
        {(data?.carriers.length ?? 0) > 1 && (
          <label>
            <span className="srOnly">Carrier</span>
            <select
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
            >
              <option value="">All carriers</option>
              {data!.carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="setupCheckbox">
          <input
            type="checkbox"
            checked={favorites}
            onChange={(e) => setFavorites(e.target.checked)}
          />
          <span>Favorites</span>
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
      <p className={notice ? "inlineNotice" : "srOnly"} role="status">
        {notice ||
          (loading ? "Searching contacts" : `${entries.length} contacts shown`)}
      </p>
      {editing && data && (
        <ContactForm
          key={editing === "new" ? "new" : editing.key}
          entry={editing === "new" ? null : editing}
          data={data}
          busy={busy || offline}
          onCancel={() => setEditing(null)}
          onSave={async (body, existing) => {
            const ok = await act(async () => {
              if (existing?.contact)
                await api(`contacts/${existing.contact.id}`, {
                  ...body,
                  version: existing.contact.version,
                });
              else await api("contacts", body);
              return existing ? "Contact updated." : "Contact added.";
            });
            if (ok) setEditing(null);
          }}
          onArchive={async (existing) => {
            if (!existing.contact) return;
            if (!window.confirm(`Remove ${existing.name} from contacts?`))
              return;
            const ok = await act(async () => {
              await api(`contacts/${existing.contact!.id}/archive`, {
                version: existing.contact!.version,
              });
              return `${existing.name} removed.`;
            });
            if (ok) setEditing(null);
          }}
        />
      )}
      {starred.length > 0 && (
        <>
          <p className="sidebarLabel">Favorites</p>
          <div className="dirList">
            {starred.map((e) => (
              <Row
                key={"fav-" + e.key}
                entry={e}
                disabled={busy || offline}
                onFavorite={() => favorite(e)}
                onEdit={e.contact?.editable ? () => setEditing(e) : undefined}
                onMessage={onMessage}
              />
            ))}
          </div>
          <p className="sidebarLabel">Everyone</p>
        </>
      )}
      <div className="dirList">
        {entries
          .filter((e) => !starred.some((s) => s.key === e.key))
          .map((e) => (
            <Row
              key={e.key}
              entry={e}
              disabled={busy || offline}
              onFavorite={() => favorite(e)}
              onEdit={e.contact?.editable ? () => setEditing(e) : undefined}
              onMessage={onMessage}
            />
          ))}
      </div>
      {!loading && !entries.length && !error && (
        <div className="directoryEmpty">
          <MagnifyingGlassIcon size={36} weight="light" aria-hidden="true" />
          <h3>
            {q || group || carrier || favorites
              ? "No matching contacts"
              : "No contacts yet"}
          </h3>
          <p>
            {q || group || carrier || favorites
              ? "Try a different name, number or filter."
              : data?.can_add
                ? "Add the brokers, shippers and receivers you work with."
                : "People you work with will appear here."}
          </p>
          {q && (
            <button
              className="secondary"
              onClick={() => (onClearQuery ?? (() => setQ("")))()}
            >
              Clear search
            </button>
          )}
        </div>
      )}
      {data?.truncated && (
        <div className="contactMore">
          {(Object.entries(data.more ?? {}) as [DirectoryGroup, number][]).map(
            ([g, total]) => (
              <button
                key={g}
                className="textButton"
                onClick={() => setGroup(g)}
              >
                Show all {total} {groupLabels[g].toLowerCase()}
              </button>
            ),
          )}
          <small>or search to narrow the list.</small>
        </div>
      )}
    </section>
  );
  function favorite(e: DirectoryEntry) {
    void act(async () => {
      await api("contacts/favorites", { key: e.key, favorite: !e.favorite });
    });
  }
}

function ContactForm({
  entry,
  data,
  busy,
  onCancel,
  onSave,
  onArchive,
}: {
  entry: DirectoryEntry | null;
  data: Directory;
  busy: boolean;
  onCancel: () => void;
  onSave: (
    body: Record<string, unknown>,
    existing: DirectoryEntry | null,
  ) => Promise<void>;
  onArchive: (entry: DirectoryEntry) => Promise<void>;
}) {
  // One retry identity per unchanged submission.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  // Carrier managers can only add contacts for their own carriers.
  const managerOnly = data.organizations.length === 0;
  const carriers = managerOnly
    ? data.carriers.filter((c) => data.manager_carriers.includes(c.id))
    : data.carriers;
  return (
    <form
      className="opsCard opsForm"
      aria-label={entry ? "Edit contact" : "Add contact"}
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body: Record<string, unknown> = {
          kind: String(f.get("kind")) as ContactKind,
          name: String(f.get("name")).trim(),
          company: String(f.get("company")).trim(),
          email: String(f.get("email")).trim(),
          phone: String(f.get("phone")).trim(),
          notes: String(f.get("notes")).trim(),
          carrier_id: String(f.get("carrier")) || null,
          sms_consent: f.get("sms_consent") === "on",
          sms_consent_note: String(f.get("sms_consent_note") || "").trim(),
        };
        if (!entry) {
          const signature = JSON.stringify(body);
          if (attempt.current?.signature !== signature)
            attempt.current = { signature, key: crypto.randomUUID() };
          body.idempotency_key = attempt.current.key;
        }
        await onSave(body, entry);
      }}
    >
      <h3>{entry ? "Edit contact" : "Add contact"}</h3>
      <div className="formGrid">
        <label>
          Name
          <input
            name="name"
            required
            maxLength={160}
            defaultValue={entry?.name}
          />
        </label>
        <label>
          Company
          <input
            name="company"
            maxLength={160}
            defaultValue={entry?.contact?.company}
          />
        </label>
      </div>
      <div className="formGrid">
        <label>
          Phone
          <input
            name="phone"
            type="tel"
            maxLength={40}
            defaultValue={entry?.phone}
          />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            maxLength={254}
            defaultValue={entry?.email}
          />
        </label>
      </div>
      <div className="formGrid">
        <label>
          Type
          <select name="kind" defaultValue={entry?.contact?.kind ?? "broker"}>
            {contactKinds.map((k) => (
              <option key={k} value={k}>
                {contactKindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Works with carrier <small>(optional)</small>
          <select
            name="carrier"
            defaultValue={
              entry?.contact?.carrier_id ?? (managerOnly ? carriers[0]?.id : "")
            }
            required={managerOnly}
          >
            {!managerOnly && <option value="">Whole organization</option>}
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Notes <small>(optional)</small>
        <textarea
          name="notes"
          rows={2}
          maxLength={1000}
          defaultValue={entry?.notes}
        />
      </label>
      <label className="setupCheckbox">
        <input
          type="checkbox"
          name="sms_consent"
          defaultChecked={entry?.sms_ok}
        />
        <span>This person agreed to receive texts from us</span>
      </label>
      <label>
        How they agreed <small>(required with consent)</small>
        <input
          name="sms_consent_note"
          maxLength={300}
          defaultValue={entry?.contact?.sms_consent_note}
          placeholder="e.g. Said yes by phone on Oct 3"
        />
      </label>
      <small>An email address or a phone number is required.</small>
      <div className="opsActions">
        <button className="primary" disabled={busy}>
          {entry ? "Save changes" : "Add contact"}
        </button>
        <button type="button" className="textButton" onClick={onCancel}>
          Cancel
        </button>
        {entry && (
          <button
            type="button"
            className="textButton"
            disabled={busy}
            onClick={() => void onArchive(entry)}
          >
            Remove contact
          </button>
        )}
      </div>
    </form>
  );
}
