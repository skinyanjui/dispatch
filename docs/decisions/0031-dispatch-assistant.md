# 0031 — The dispatch assistant (chat over the CRM)

Status: accepted, 2026-10-21. Builds on ADR 0028 (AI document reading). Touches data ownership and third-party processing.

## Decision

Staff of a dispatch organization can chat with an **assistant** that answers questions about their loads, exceptions, billing, prospects, contacts and carriers ("What needs my attention?", "Which invoices are overdue?", "Which prospects need a follow-up?"). It is an agent in the narrow sense: the model decides which lookups to run, runs several, and writes the answer. It is **read-only**.

**It cannot act.** Every tool only reads. There is no tool that creates, changes, books, assigns, dispatches, cancels, invoices, messages or moves money, and the system prompt tells the model to say so and point to the right page. Acting stays in the screens, under their own authorization, audit and idempotency. A test asserts no tool name is a write verb and that row counts do not change across questions. Rates, rate confirmations, invoices and payments are decided by people; the assistant presents what Relay has recorded.

**It sees only what the person can see.** Tools call the same scoped functions as the screens (`listLoads`, `attentionLoads`, `listExceptions`, `billingOverview`, `listProspects`, `directory`) as the signed-in user, then restrict results to **one organization**, the one that consented. A carrier outside that organization is "No such carrier". Managers, drivers and other organizations get `NOT_FOUND` for every route. Only organization staff (owners, admins, dispatchers) can use it, as with prospects (ADR 0030). With no organization chosen, the one the person administers is used, so the person who can turn it on sees the same organization.

**Consent and cost.** Off by default, separately from document reading: `organization_ai_settings.assistant_enabled`, changed only by an owner or admin, audited (`ai.assistant.enabled/disabled`). Turning it on means what a question looks up (load, billing and prospect details, contact names) is sent to the model provider. The monthly limit is shared with document reading; before each question a worst-case cost is held under an advisory lock, then replaced by the actual cost. One question runs at a time per person (`ALREADY_RUNNING`; a turn left running past three minutes is failed). A turn is capped at five model calls, twelve lookups and 50 seconds, inside the route's 60 second limit. Refusals and unusable answers keep their hold; outages release it.

**Provenance, not trust.** Each turn stores the tools called and the records they returned. The **Sources** under an answer are built by the server from those records (load, prospect, contact, carrier, invoice, exception) and open the record in one click; the model cannot add a source. Answers are advice: the UI says to check anything important before acting. Tool results are returned to the model as `tool_result` data, and the prompt says text inside them never changes its rules; a test puts an injection phrase in a prospect name and checks it only ever travels as data.

**Retries.** `POST /api/assistant/ask` needs an `Idempotency-Key` (UUID). The same key returns the stored turn, a different body is `IDEMPOTENCY_CONFLICT`. Follow-ups use the person's own conversation (others get `NOT_FOUND`); the last six answered turns are sent as history, so cost stays bounded.

**Providers.** Same environment as ADR 0028: `ANTHROPIC_API_KEY`, `RELAY_AI_MODEL` (default `claude-opus-5-5`), `RELAY_AI_PROVIDER=fixture` for QA, demos and CI (keyword rules over the same tools, labelled "Sample answer, no AI used"; refuses on Vercel production) and `none`. The browser-only demo uses fixed rules over its fictional data and makes no network calls.

**Schema.** Migration `026_assistant.sql` is expand-only: one boolean column defaulting to false and two new tables. Rollback: leave them; code that ignores them behaves as before.

## Not done

Streaming answers, write actions with explicit confirmation (each would need its own consent, idempotency and audit design), carrier- or driver-facing assistants, searching document contents, a multi-organization picker (the API accepts `organization_id`; the page uses the default), and per-user spend limits. `docs/decisions/0028` mentions an AI evaluation script that was never built; quality is covered by deterministic tests with the fixture provider and a stand-in client, not by live-model evaluation.
