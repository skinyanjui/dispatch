# 0030 — Prospects (managing prospective carrier clients)

Status: accepted, 2026-10-21. Touches data ownership and the dispatch/carrier boundary.

## Decision

Relay has a **Prospects** page where a dispatch organization tracks carriers it is courting, from first contact to signed.

**A prospect is not a carrier.** It is a sales record owned by the dispatch organization (`prospects.organization_id`). It has no login, no membership, no documents and cannot be assigned freight. Only organization staff (owners, admins and dispatchers) can read or change prospects. Carrier managers, drivers and other organizations get `NOT_FOUND` for every route, including guessed IDs, so a carrier can never see how it was pursued. Prospect data is never joined into carrier-facing queries, exports or webhooks.

**One source of truth.** The prospect row holds its current stage, owner, follow-up date and contact details. `prospect_activities` is append-only (trigger `immutable_event`): notes, calls, emails, meetings, stage changes and the conversion. Corrections are new entries. Stage and follow-up are never derived from activity text.

**Stages.** New → Contacted → Qualified → Agreement sent → Won, or Lost. Lost requires a reason (database check and API). Won and Lost clear the follow-up date. Any stage can be reopened except for a prospect that became a carrier.

**Starting carrier setup is explicit and narrow.** `POST /api/prospects/:id/convert` creates a carrier in the same organization with a setup profile (contact name and email are required), gives the acting dispatcher the usual dispatcher membership, emits `carrier.created` through the existing onboarding outbox, marks the prospect Won, and records `converted`. It repeats safely (returns the carrier already created). It books nothing and creates no dispatch authorization: a load still needs a verified, written dispatch agreement before it can be booked or assigned. "Won" means "agreed to work with us", not "authorized".

**No outbound messages.** Nothing in Prospects sends an email, text or call. Logging an email or call records that a person did it. Any future outreach feature needs consent, idempotency and an audit trail under the messaging rules.

**Concurrency and retries.** Edits, stage moves, archive and conversion use optimistic versions (`VERSION_CONFLICT`). Create and activity logging take an idempotency key (unique per user) and a request hash: the same key returns the same result, a different body is `IDEMPOTENCY_CONFLICT`. Logging activity does not bump the prospect version, so a note never causes an edit conflict, except when it also sets the next follow-up. Every change writes an `audit_logs` row.

**Schema.** Migration `025_prospects.sql` is expand-only (two new tables). Rollback: stop using the API and leave the tables; nothing else depends on them except `prospects.carrier_id`, which references carriers one way.

**UI.** One sidebar entry, shown only to staff. A six-lane board (the user chose board-only views), search, owner filter and follow-up chips (Overdue / Today / Next 7 days). One click on a card opens a drawer with details, a single stage selector (selecting applies, so moving a prospect is one action), activity logging with an optional next follow-up date, the timeline, Start carrier setup and Archive. Date math uses the server's date so counts and card text agree. The browser-only demo mirrors the rules in `src/lib/demo-prospects.ts` with fictional data.

## Not done

Import/export of prospects, bulk edits, reminders by email or push, drag-and-drop between lanes (use the stage selector; keyboard accessible), duplicate detection against existing carriers, and per-owner permissions beyond organization staff. Archive hides a prospect; there is no restore screen yet.

## Board layout

Presentation only. The six stages now share the page width (each at least 176px wide) so the last stage, Lost, is no longer cut off at desktop widths; below that the board still scrolls sideways. On phones each stage is about 84% of the screen and snaps, with the next stage peeking in. Company names wrap to two lines instead of being truncated, the stage count lines up with its name, and the intro keeps only the sentence that matters: starting carrier setup creates the carrier record only.

## Addendum: one shared board

Loads and Prospects are drawn by the same board component (`src/components/board.tsx`) and styled from one stylesheet (`src/app/board.css`), which replaces board rules that had spread across eight stylesheets. Both boards have the same lane anatomy (stage dot, name, count), empty state, phone and tablet scrolling, and drag-to-move. Prospect cards use the load card's layout: name and truck count, contact, then small facts. Dragging a prospect to another stage records the stage change like the Stage menu does. Dropping it on Lost opens the prospect at "Why was it lost?", because Lost needs a reason. A prospect that became a carrier cannot be dragged. Dragging is a shortcut: every move can still be made from the record. No API or permission change.
