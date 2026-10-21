# 0028 — AI document reading

Status: accepted, 2026-10-21. Implements Task 7 of `docs/codex-tasks.md` for the first feature.

## Decision

Relay can ask Claude to **read one uploaded document** and suggest values for a short list of fields. A person compares the suggestions with the file. The model never changes a load, a document, a review decision, a billing packet or an invoice, and it has no tools.

**What is read.** Auto-liability and cargo insurance (insurer, policy number, named insured, effective and expiry dates, coverage limit), rate confirmations (reference, broker, rate, pickup and delivery dates), bills of lading and proofs of delivery (numbers, dates, parties, whether signed, damage noted). **Never sent:** W-9s (tax ID numbers) and dispatch agreements (written authority to book freight is a human, audited decision). Field lists live in `src/lib/extraction.ts`.

**Off by default, twice.** Nothing runs unless the deployment has `ANTHROPIC_API_KEY` *and* an organization owner or admin turns it on under Organization settings (table `organization_ai_settings`). Turning it on is the consent to send that organization's paperwork to the model provider; it is audited (`ai.extraction.enabled/disabled`). A monthly limit in cents (default 10 USD) caps spend.

**Who can read.** Dispatchers and carrier managers of the document's carrier, on the current version of a file, under the same checks as reviewing it. Drivers and other tenants get `NOT_FOUND`; a cancelled load's documents cannot be read.

**Suggestions are advice, compared in plain code.** The model returns each value with a confidence and a quote copied from the file. `extractionChecks` (pure code, no AI) compares them with what Relay already has: expiry entered at upload, the load's agreed rate, the pickup and delivery dates, an unsigned POD. A mismatch is a reason to look, never a change. A person can mark a reading **checked** (optionally with corrected values, stored for provenance) or **dismiss** it. Applying a value still goes through the normal, audited edit.

**Money and provenance.** Costs are integer micro-dollars. Each row stores provider, model, prompt version, token counts, requested-by, and the cost. Before the call, a worst-case cost is held against the month's limit under an advisory lock, so concurrent requests cannot overspend; the actual cost replaces the hold. Unknown models are priced at the highest known rate. Refusals and unusable answers keep their hold; outages and rejected files release it. A request left running past five minutes is failed.

**Idempotency and limits.** `POST /api/documents/:versionId/read` needs an `Idempotency-Key`. The same key returns the stored result; a good reading is returned instead of a second paid one; three failures per version stop further attempts (`TOO_MANY_ATTEMPTS`). Dismissing allows a new reading.

**Prompt safety.** The system prompt says the file is untrusted data and instructions inside it are ignored. The request carries one file and a field list, no tools, and a structured-output schema; results are re-validated (dates `YYYY-MM-DD`, money as whole cents) before they are stored.

**Model.** `claude-opus-5-5` by default; `RELAY_AI_MODEL` selects another model and cost follows its price. The call uses the official SDK, structured outputs, low effort, and the server-side refusal fallback (`fallbacks: "default"`). A `fixture` provider (`RELAY_AI_PROVIDER=fixture`) returns labelled sample values with no network for QA, demos and CI; it refuses to run on Vercel production.

**Tenancy and data.** Files are read from the same store and verified against the stored checksum before sending. Nothing from the database is sent besides the file and its document type. Nothing is cached or indexed by Relay beyond the stored suggestions. Review the model provider's current data-retention terms before enabling for real customers.

## What this does not do

It does not book, accept, price, invoice, reallocate or move money, and it does not read freight documents on its own: every reading is requested by a person. Accuracy on real paperwork has **not** been measured here; `npm run ai:eval` runs the synthetic fixtures against the live model and reports field accuracy and cost, and must be run, with the key and an explicit `--yes`, before relying on it.

## Rollback

Migration 024 is additive (two tables). Disable per organization in settings, or remove `ANTHROPIC_API_KEY`; code that ignores the tables behaves as before. Stored suggestions can be left in place or deleted without effect on any record.
