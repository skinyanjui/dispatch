# 0040 — Document templates, drafts and the drafting assistant

## Context

We were asked to build an AI agent that can "generate a document from a template and a record", guided by the document-generator tutorial in the Twenty CRM docs (ideas only, no code; see ADR 0036). In that tutorial one function is exposed as a _tool_ and so has many front doors: a command, an HTTP route, a workflow step and an agent in chat.

## Decision

- **One function, several front doors.** `generateDraft` (src/lib/drafts.ts) fills a template from one record. It is reached from the Documents page (people), a "Draft a document" control in the load drawer (people), and the assistant's `draft_document` tool. All three go through the same authorization, idempotency and audit.
- **Templates** (`document_templates`, migration 034) are plain text with `{{merge fields}}` for a load, a carrier or a contact, plus `{{sender.name}}` and `{{today}}`. Only listed fields are accepted. Filling is a plain lookup: no code runs and no model is involved, so the same inputs always give the same text.
- **Drafts** (`document_drafts`) hold the rendered text, which a trigger prevents from changing. A value that is empty stays visible as `[missing: field]` and the draft lists its missing fields, so a reviewer cannot miss a gap.
- **Human review.** A draft starts as "Needs review". "Mark as reviewed" records that a person read it; discarding hides it. Nothing is sent, booked, invoiced or stored as a load document. Rates, rate confirmations, invoices and payments are never authored by the assistant (AGENTS.md: AI is a human-reviewed helper).
- **The assistant** gains two tools: `list_document_templates` (read) and `draft_document` (creates a draft). It chooses the template and names the record (a load reference, carrier name or contact name); the server resolves it only among records the person can already see, in the consenting organization. The same request in the same minute is the same draft, so a retried step cannot duplicate it. Prompt version is now `assistant-2`; the assistant still cannot change loads, assign, dispatch, cancel, invoice, send or move money.
- **Who:** organization staff only (owners, admins, and dispatchers of that organization's carriers). Drivers and carrier managers get 404.
- **Audit:** `template.created|updated|archived`, `draft.generated`, `draft.generated.assistant`, `draft.approved`, `draft.discarded`.

## Not done

Sending a draft as a message with one click (copy only for now), PDF export, versioned templates beyond a version counter, merge fields for invoices, and workflow triggers.

## Rollback

Additive. Leave both tables unused, or remove the two assistant tools; nothing else depends on them.

## Page polish

Presentation only; no API, schema or permission change. The page opens on "All" when nothing needs review (it used to open on an empty "Needs review" list while approved drafts existed); "Needs review" is still the default when something does. The intro keeps one sentence. Templates are a bordered list with a two-line preview and their actions on the right, or full-width under the text on phones. Drafts become compact cards on phones (name, then For and Status side by side), and the status chips wrap and fill their rows.

> **Superseded in part by ADR 0052.** Lists described above as cards on phones, or with labelled facts in each row, are now `DataTable`s: column names appear once in the header, narrow screens scroll sideways with the row name held in place, low-priority columns drop out under 640px, and sorting is on the column headers (no separate sort select). See `docs/design-system.md`.
