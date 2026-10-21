# 0029 — The board answers the usual questions

Status: accepted, 2026-10-21. Extends ADR 0027 (board-only loads).

## Decision

A dispatcher's four daily questions are answered on the load board itself, without opening a load: **what needs me**, **when is the next appointment and who is driving**, **is the paperwork in**, and **what happens next**.

**One rule set.** `src/lib/attention.ts` is pure code shared by the server, the browser and the demo. `summarize(input, now)` returns the next unfinished stop, the driver, document counts (accepted / pending / rejected / missing), open and overdue exceptions, and an ordered list of reasons with a level (`late`, `soon`, `attention`, `ok`). Reasons are `late` (appointment window ended or exception overdue), `soon` (window opens within 4 hours), `no_driver`, `paperwork` (rejected, awaiting review, or the rate confirmation / BOL / POD expected for the current stage and missing), and `exception`. Cancelled loads never raise reasons.

**Recorded facts only.** The rules read appointments, recorded arrivals, assignment, document status and exceptions. They never claim a truck's position; "late" means a window ended with no recorded arrival.

**Server.** `src/lib/load-summary.ts` batches the inputs for a page of loads (no per-load queries) and `withSummaries` attaches `summary` to each load in list responses, inside the existing carrier scoping. `GET /api/loads/attention` returns the loads that need attention, most urgent first. No new tables, so no migration; it is derived on read and cannot disagree with the source records (single source of truth).

**UI.** Each card shows the next appointment ("Pickup in 2h"), driver (or "No driver"), paperwork ("Docs 2/3") and a one-line next step. A strip of count chips (Late, Next 4 hours, No driver, Paperwork, Exceptions) filters the board in one click; chips have text and counts, not colour alone, and announce changes politely. The browser-only demo mirrors the same fields through `demo-api.ts`.

## Actions from question to answer

| Question | Before | After |
| --- | --- | --- |
| Which loads need attention? | open every load (N+) | 0 (strip), 1 to filter |
| Next appointment and driver? | open load, read stops and assignment (2+) | 0 |
| Is the paperwork in? | open load, open documents (3+) | 0 |
| What is the next step? | open load, interpret milestones (2+) | 0 |

## Consequences

Summaries are computed per request from live rows, so very large boards add a few batched queries per page. Thresholds (4 hours, expected documents per stage) are constants in one file and covered by `tests/integration/attention.test.ts` and a Chromium test.
