"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileTextIcon, PlusIcon } from "@phosphor-icons/react";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { DataTable, type ColumnDefinition } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { Sheet } from "@/components/modal";
import { ApiError, useApi } from "@/lib/client-api";
import { EmptyState, ErrorAlert, PageIntro } from "@/components/ui/feedback";

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
  const draftColumns: ColumnDefinition<Draft>[] = [
    {
      id: "draft",
      header: "Draft",
      accessor: "template_name",
      render: (name) => (
        <>
          <FileTextIcon size={14} aria-hidden="true" />
          {String(name)}
        </>
      ),
    },
    { id: "for", header: "For", accessor: "target_label" },
    {
      id: "status",
      header: "Status",
      accessor: "status",
      render: (_, d) => (
        <>
          <StatusBadge
            tone={
              d.status === "approved"
                ? "good"
                : d.status === "discarded"
                  ? "neutral"
                  : "warn"
            }
          >
            {statusLabels[d.status]}
          </StatusBadge>
          {d.missing.length > 0 && d.status === "draft" && (
            <small className="agingNote late">{d.missing.length} missing</small>
          )}
        </>
      ),
    },
    {
      id: "by",
      header: "Made by",
      accessor: (d) =>
        d.source === "assistant"
          ? "Assistant for " + d.created_by_name
          : d.created_by_name,
      priority: "low",
    },
    {
      id: "created",
      header: "Created",
      accessor: "created_at",
      type: "datetime",
      sortable: true,
      descendingFirst: true,
    },
  ];
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
      <PageIntro title="Documents">
        A draft is text for you to review and copy; nothing is sent from here.
      </PageIntro>
      <Tabs
        label="Documents"
        idPrefix="documents"
        items={[
          { id: "drafts", label: "Drafts", count: drafts?.length ?? 0 },
          {
            id: "templates",
            label: "Templates",
            count: templates?.length ?? 0,
          },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error && <ErrorAlert error={error} onRetry={() => void load()} />}
      <p className="srOnly" aria-live="polite">
        {status}
      </p>

      <TabPanel idPrefix="documents" value={tab}>
        {tab === "drafts" && (
          <>
            <ToggleGroup
              label="Show drafts"
              items={(["draft", "approved", "discarded", "all"] as const).map(
                (f) => ({
                  id: f,
                  label: f === "all" ? "All" : statusLabels[f],
                  count:
                    f === "all"
                      ? (drafts ?? []).length
                      : (drafts ?? []).filter((d) => d.status === f).length,
                }),
              )}
              value={filter}
              onChange={(f) => f && setFilter(f)}
            />
            <DataTable
              caption="Document drafts"
              columns={draftColumns}
              data={shown}
              getRowId={(d) => d.id}
              loading={!drafts}
              onRowOpen={(d) => setOpen(d.id)}
              openLabel={(d) =>
                `Open draft ${d.template_name} for ${d.target_label}`
              }
              empty={{
                title: "No drafts here",
                description:
                  "Ask the assistant to draft one, or use Draft document on a load.",
              }}
            />
          </>
        )}

        {tab === "templates" && (
          <>
            {/* The page action for this tab sits in its panel, so switching
              tabs never moves the tab strip. */}
            <div className="panelToolbar">
              <button
                className="primary"
                disabled={offline}
                onClick={() => setEditing("new")}
              >
                <PlusIcon size={14} weight="bold" aria-hidden="true" /> New
                template
              </button>
            </div>
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
                              () =>
                                api(`document-templates/${t.id}/archive`, {}),
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
              <EmptyState
                icon={FileTextIcon}
                title={templates ? "No templates yet" : "Loading…"}
                description={
                  <>
                    A template is text like “Hi {"{{carrier.contact}}"}, an
                    update on {"{{load.reference}}"}…”. Create one to start
                    drafting.
                  </>
                }
              />
            )}
          </>
        )}
      </TabPanel>

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
              <ErrorAlert>
                Missing values: {current.missing.join(", ")}. Fill these in
                before using the text.
              </ErrorAlert>
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
          <ErrorAlert error={error} />
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
