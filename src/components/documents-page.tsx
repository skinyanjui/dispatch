"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileTextIcon, PlusIcon } from "@phosphor-icons/react";
import { Sheet } from "@/components/modal";
import { ApiError, describe, useApi } from "@/lib/client-api";

type Draft = {
  id: string;
  template_name: string;
  target: "load" | "carrier" | "contact";
  target_label: string;
  body: string;
  missing: string[];
  source: "person" | "assistant";
  status: "draft" | "approved" | "discarded";
  created_at: string;
  created_by_name: string;
};
type Template = {
  id: string;
  name: string;
  target: "load" | "carrier" | "contact";
  body: string;
  version: number;
};
type Fields = Record<string, Record<string, string>>;
const statusLabels = {
  draft: "Needs review",
  approved: "Approved",
  discarded: "Discarded",
} as const;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Templates and the drafts made from them (ADR 0040). A draft is text for a
 * person to review and copy; approving it only records that a person checked
 * it. Nothing here sends, books or invoices.
 */
export function DocumentsPage({
  offline,
  query = "",
  openDraft,
  onAuthError,
}: {
  offline: boolean;
  query?: string;
  /** Open this draft on arrival (from an assistant answer). */
  openDraft?: string | null;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [tab, setTab] = useState<"drafts" | "templates">("drafts"),
    [filter, setFilter] = useState<"all" | Draft["status"]>("draft"),
    [drafts, setDrafts] = useState<Draft[] | null>(null),
    [templates, setTemplates] = useState<Template[] | null>(null),
    [fields, setFields] = useState<Fields>({}),
    [open, setOpen] = useState<string | null>(openDraft ?? null),
    [editing, setEditing] = useState<Template | "new" | null>(null),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  // On the first load, an empty "Needs review" list would hide the drafts that
  // exist; show all of them instead.
  const chosenFilter = useRef(false);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([
        api<{ drafts: Draft[] }>("drafts"),
        api<{ templates: Template[]; fields: Fields }>("document-templates"),
      ]);
      setDrafts(d.drafts);
      if (!chosenFilter.current) {
        chosenFilter.current = true;
        if (d.drafts.length && !d.drafts.some((x) => x.status === "draft"))
          setFilter("all");
      }
      setTemplates(t.templates);
      setFields(t.fields);
      setError("");
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);
  useEffect(() => {
    // Fetch once on mount; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (drafts ?? [])
        .filter((d) => filter === "all" || d.status === filter)
        .filter(
          (d) =>
            !needle ||
            [d.template_name, d.target_label, d.created_by_name]
              .join(" ")
              .toLowerCase()
              .includes(needle),
        ),
    [drafts, filter, needle],
  );
  const current = drafts?.find((d) => d.id === open);
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setStatus(done);
      await load();
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="carrierDirectory documents" aria-label="Documents">
      <div className="directoryIntro">
        <div>
          <h2 className="srOnly">Documents</h2>
          <p className="dirNote">
            A draft is text for you to review and copy; nothing is sent from
            here.
          </p>
        </div>
        {tab === "templates" && (
          <button
            className="primary"
            disabled={offline}
            onClick={() => setEditing("new")}
          >
            <PlusIcon size={14} weight="bold" aria-hidden="true" /> New template
          </button>
        )}
      </div>
      <div className="orgTabs" role="tablist" aria-label="Documents">
        {(
          [
            ["drafts", "Drafts", drafts?.length ?? 0],
            ["templates", "Templates", templates?.length ?? 0],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={"orgTab" + (tab === key ? " active" : "")}
            onClick={() => setTab(key)}
          >
            {label}
            <span className="orgCount">{n}</span>
          </button>
        ))}
      </div>
      {error && (
        <div className="alert error" role="alert">
          {describe(error)}
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <p className="srOnly" aria-live="polite">
        {status}
      </p>

      {tab === "drafts" && (
        <>
          <div className="attentionChips" role="group" aria-label="Show drafts">
            {(["draft", "approved", "discarded", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className="attentionChip"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : statusLabels[f]}
                <b>
                  {f === "all"
                    ? (drafts ?? []).length
                    : (drafts ?? []).filter((d) => d.status === f).length}
                </b>
              </button>
            ))}
          </div>
          {shown.length ? (
            <div className="tableScroll billingTable">
              <table className="reportTable">
                <caption className="srOnly">Document drafts</caption>
                <thead>
                  <tr>
                    <th scope="col">Draft</th>
                    <th scope="col">For</th>
                    <th scope="col">Status</th>
                    <th scope="col">Made by</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((d) => (
                    <tr
                      key={d.id}
                      className="clickRow"
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest("button"))
                          setOpen(d.id);
                      }}
                    >
                      <th scope="row" data-label="Draft">
                        <button
                          type="button"
                          className="textButton"
                          onClick={() => setOpen(d.id)}
                          aria-label={`Open draft ${d.template_name} for ${d.target_label}`}
                        >
                          <FileTextIcon size={14} aria-hidden="true" />
                          {d.template_name}
                        </button>
                      </th>
                      <td data-label="For">{d.target_label}</td>
                      <td data-label="Status">
                        <span
                          className={
                            "opsPill " +
                            (d.status === "approved"
                              ? "good"
                              : d.status === "discarded"
                                ? ""
                                : "warn")
                          }
                        >
                          {statusLabels[d.status]}
                        </span>
                        {d.missing.length > 0 && d.status === "draft" && (
                          <small className="agingNote late">
                            {d.missing.length} missing
                          </small>
                        )}
                      </td>
                      <td data-label="Made by">
                        {d.source === "assistant"
                          ? "Assistant for " + d.created_by_name
                          : d.created_by_name}
                      </td>
                      <td data-label="Created">{when(d.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="directoryEmpty">
              <FileTextIcon size={32} weight="light" aria-hidden="true" />
              <h3>{drafts ? "No drafts here" : "Loading…"}</h3>
              <p>
                Ask the assistant to draft one, or use Draft document on a load.
              </p>
            </div>
          )}
        </>
      )}

      {tab === "templates" && (
        <>
          {templates && templates.length ? (
            <ul className="templateList" aria-label="Templates">
              {templates.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.name}</strong>
                    <small>Fills from a {t.target}</small>
                    <p>{t.body.slice(0, 160)}</p>
                  </div>
                  <div className="actionRow">
                    <button
                      className="secondary"
                      disabled={offline}
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </button>
                    <button
                      className="textButton"
                      disabled={busy || offline}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Archive “${t.name}”? Existing drafts stay.`,
                          )
                        )
                          void run(
                            () => api(`document-templates/${t.id}/archive`, {}),
                            "Template archived.",
                          );
                      }}
                    >
                      Archive
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="directoryEmpty">
              <FileTextIcon size={32} weight="light" aria-hidden="true" />
              <h3>{templates ? "No templates yet" : "Loading…"}</h3>
              <p>
                A template is text like “Hi {"{{carrier.contact}}"}, an update
                on {"{{load.reference}}"}…”. Create one to start drafting.
              </p>
            </div>
          )}
        </>
      )}

      {current && (
        <Sheet
          label="Draft"
          eyebrow={statusLabels[current.status]}
          onClose={() => setOpen(null)}
        >
          <div className="inspectorBody">
            <h3>
              {current.template_name} · {current.target_label}
            </h3>
            {current.source === "assistant" && (
              <p className="helpText">
                Written by the assistant for {current.created_by_name} from your
                template and records. Check every line before using it.
              </p>
            )}
            {current.missing.length > 0 && (
              <p className="alert error" role="alert">
                Missing values: {current.missing.join(", ")}. Fill these in
                before using the text.
              </p>
            )}
            <pre className="draftBody" tabIndex={0} aria-label="Draft text">
              {current.body}
            </pre>
            <div className="actionRow">
              <button
                className="secondary"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(current.body)
                    .then(() => setStatus("Copied."))
                }
              >
                Copy text
              </button>
              <a
                className="secondary"
                href={`/api/drafts/${current.id}/pdf`}
                download
              >
                Download PDF
              </a>
              {current.status === "draft" && (
                <>
                  <button
                    className="primary"
                    disabled={busy || offline}
                    onClick={() =>
                      void run(
                        () => api(`drafts/${current.id}/approve`, {}),
                        "Marked as reviewed.",
                      )
                    }
                  >
                    Mark as reviewed
                  </button>
                  <button
                    className="textButton"
                    disabled={busy || offline}
                    onClick={() =>
                      void run(
                        () => api(`drafts/${current.id}/discard`, {}),
                        "Draft discarded.",
                      ).then((ok) => ok && setOpen(null))
                    }
                  >
                    Discard
                  </button>
                </>
              )}
            </div>
            <small className="helpText">
              Reviewed means a person read it. Relay does not send it anywhere.
            </small>
          </div>
        </Sheet>
      )}

      {editing && (
        <TemplateSheet
          template={editing === "new" ? null : editing}
          fields={fields}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const ok = await run(
              () =>
                editing === "new"
                  ? api("document-templates", input)
                  : api(`document-templates/${editing.id}`, {
                      version: editing.version,
                      name: input.name,
                      body: input.body,
                    }),
              "Template saved.",
            );
            if (ok) setEditing(null);
          }}
          busy={busy}
          error={error}
        />
      )}
    </section>
  );
}

function TemplateSheet({
  template,
  fields,
  onClose,
  onSave,
  busy,
  error,
}: {
  template: Template | null;
  fields: Fields;
  onClose: () => void;
  onSave: (input: { name: string; target: string; body: string }) => void;
  busy: boolean;
  error: string;
}) {
  const [name, setName] = useState(template?.name ?? ""),
    [target, setTarget] = useState<Template["target"]>(
      template?.target ?? "load",
    ),
    [body, setBody] = useState(template?.body ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  const available = fields[target] ?? {};
  function insert(field: string) {
    const el = area.current;
    const token = `{{${field}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart,
      end = el.selectionEnd;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }
  return (
    <Sheet
      label={template ? "Edit template" : "New template"}
      eyebrow="Template"
      onClose={onClose}
    >
      <div className="inspectorBody">
        <form
          className="opsForm"
          aria-label="Template"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ name, target, body });
          }}
        >
          <label>
            Name
            <input
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Fills from
            <select
              value={target}
              disabled={!!template}
              onChange={(e) => setTarget(e.target.value as Template["target"])}
            >
              <option value="load">A load</option>
              <option value="carrier">A carrier</option>
              <option value="contact">A contact</option>
            </select>
          </label>
          <div className="mergeFields" role="group" aria-label="Insert a field">
            {Object.entries({ ...available }).map(([field, label]) => (
              <button
                key={field}
                type="button"
                className="attentionChip"
                onClick={() => insert(field)}
                title={`{{${field}}}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label>
            Text
            <textarea
              ref={area}
              rows={10}
              maxLength={8000}
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          {error && (
            <p className="alert error" role="alert">
              {describe(error)}
            </p>
          )}
          <div className="actionRow">
            <button className="primary" disabled={busy}>
              Save template
            </button>
            <button type="button" className="textButton" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </Sheet>
  );
}
