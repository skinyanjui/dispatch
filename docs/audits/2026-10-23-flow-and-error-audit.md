# Flow and error audit — 2026-10-23

Baseline: `d233668` on a local PostgreSQL 16 database (migrations 001–039, `npm run db:seed`), Next.js dev server, fictional QA data only. No email, SMS, storage, scanner, AI or sign-in provider was reachable, so provider paths are covered only by the in-process fakes in the integration tests. Earlier audits (2026-10-20 to 2026-10-22) already cover authorization, backend reconciliation and a first exploratory sweep; this pass did not repeat them and looked at failure behavior and at what changed since.

## What was run

| Check                                                                                                                                            | Result                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `npm test` (static demo check and integration tests against PostgreSQL)                                                                          | 301 / 301                                                           |
| Exploratory sweep: 15 pages × dispatcher, carrier manager and driver × 1440px and 390px (90 runs)                                                | Axe WCAG 2 A/AA: no violations. No overflow, page errors or 5xx.    |
| Error injection on five write flows (create load, add vehicle, add contact, send message, save profile)                                          | 500, network down, lost reply then retry, double submit: see below  |
| Error injection on every page's reads (500 and network down)                                                                                     | Every page says so; three recovery defects found and fixed          |
| Authorization probe of the endpoints added since 2026-10-22 (exports, export download, invoices, status, capabilities, message result, webhooks) | No defects                                                          |
| Public flows (sign-in, rate limit, reset, verify, invitation, request access, unknown addresses, offline)                                        | No defects                                                          |
| Full browser suite (local, development server, 197 specs)                                                                                        | 192 passed, 5 failed before the queue-strip fix; see "Verification" |

## Sound (checked and held)

- **Failed write, server error or network down:** every flow shows a plain-words message, keeps the form open with the typed values, and a retry succeeds with exactly one record.
- **Lost reply:** the server finished the work and the reply was dropped. Retrying created one record, not two, and showed the success message (idempotency keys work end to end for load, vehicle, contact and message).
- **Double submit:** a second click while the first is in flight sends one request and creates one record.
- **Expired session:** a real expiry (cookie removed) returns to sign-in with "Please sign in to continue."
- **Concurrent edit:** a stale save of a vehicle was refused and changed nothing (no silent overwrite).
- **Report exports:** queued, prepared, "5 rows prepared. Ready to download.", and the CSV downloads with the right header and rows. Formulas in cells are neutralised (`csvCell`, tested). Another user's export returns 404, replaying a key with different filters returns 409, a true replay is safe, a foreign or missing `Origin` returns 403, and unsigned webhooks are refused.
- **Public links:** reset, verify and invitation links with a bad or missing token each explain what happened and where to go next. Sign-in is rate limited after 8 attempts with a clear message. Offline shows a banner, disables actions and clears on reconnect.

## Defects found and fixed

1. **A failed background load left a banner nobody could remove.** When the loads request failed, every page except Loads showed an error banner with no Retry; after the page's own Retry recovered the page, the banner stayed. The shell banner now offers Retry on every page and clears on success. (`dispatch-workspace.tsx`)
2. **Account and Organization were dead ends.** If their data failed to load they showed two identical banners, an empty page and no Retry; only a full reload helped. Both now offer Retry until their data has loaded.
3. **Wrong wording for edit conflicts.** `VERSION_CONFLICT` said "Someone just updated this load. Refresh to see the latest" for vehicles, accounts, contacts and invoices, and promised a Refresh button the dialog does not have. It now reads "Someone just updated this. Refresh the page to see the latest, then try again."
4. **A useless Retry on "not available to your account".** Opening an address that does not exist or is not yours offered Retry, which can never change that answer. Retry is no longer shown for `NOT_FOUND`.
5. **A keyboard-access gap in the queue tabs, and a flaky accessibility test.** On phones the queue strip (All loads, Ready to dispatch, ...) scrolls sideways. While the workspace is busy, for instance as a load opens, every tab is disabled, leaving a scroll region with nothing focusable in it, which axe reports as `scrollable-region-focusable` and which cannot be scrolled from the keyboard. The phone accessibility test failed 3 runs in 5 for this reason. The strip now takes focus itself while its tabs are disabled; the test passed 6 of 6 afterwards. (`workspace-shell.tsx`)
6. **A test helper tripped a pg deprecation (an error in pg 9).** `utc-ranges.test.ts` ran an un-awaited `SET TIME ZONE` in a connect handler, racing the first query. The time zone is now a connection option (`PGOPTIONS`), and the test asserts the session really is in Los Angeles time.

Each fix has a browser or integration test that fails without it (`tests/browser/error-states.spec.ts`, `tests/integration/utc-ranges.test.ts`).

## Open items, closed in a follow-up (2026-10-23)

All six items that were open here were fixed afterwards:

1. **Two banners for one failure.** A failed loads request is the Loads page's own business: it is no longer raised as a shell banner while another page is showing (Loads shows "Couldn't load" in its list), and opening Loads retries it. A failure now shows one banner.
2. **Pages a role cannot open fired requests first.** The shown page is derived from the role, so a page the person may not use is never mounted: no data requests, and no 404s in the console. (`dispatch-workspace.tsx`)
3. **Typed work lost on session expiry.** The workspace now stays mounted when the session ends, and sign-in appears over it as a native modal dialog (it stacks above an open drawer, makes the rest inert and cannot be dismissed with Escape). After the same person signs in, their dialog and typed text are still there; if someone else signs in the page reloads, so they never inherit the previous person's screen. Only `AUTH_REQUIRED` and `SESSION_EXPIRED` mean the session ended: a wrong password in the overlay shows its own message.
4. **Inbox "find people" hid a failed search.** A failed lookup now shows an error with Retry, and an empty one says "No one matches ...".
5. **Reports tile label wrapped.** "Delivered, no accepted POD" is now "POD not accepted", with "On delivered loads" as its detail, so no label wraps at 1440px and no tile has a gap above its figure.
6. **Exports could stall silently.** A queued export nobody starts within 30 minutes is failed with `EXPORT_STALLED` ("This export never started... Prepare it again"), which also frees its place in the user's limit of three waiting exports (three stuck jobs used to lock a person out for 24 hours). Waiting more than two minutes shows "This is taking longer than expected". The stall is logged (`report.export_stalled`) and counted in `GET /api/operations/status` (`exports.waiting`, `exports.stalled_last_24h`).

Decision record: `docs/decisions/0057-session-expiry-keeps-drafts.md`.

Tests: `tests/browser/error-states.spec.ts` (one test or more per item; the banner and gating tests fail on the earlier code), `tests/integration/report-export-stalls.test.ts` (fails without the stall rule) and `tests/browser/stat-tiles.spec.ts`.

## Open

- **Edit conflicts have no in-dialog refresh.** The load dialog has "Refresh load details"; the vehicle, contact and other editors tell the person to refresh the page.
- **No alerting on stalled exports.** The stall is now visible to the person, in the log and in the operations status, but nothing pages anyone: the existing observability gap (no metrics, alerting or dead-letter view).
- **The expired-session overlay keeps page-owned data in the page.** The loads list is cleared at once, but data inside a page's own components (for example the Fleet table) stays behind the inert dialog until sign-in or reload (ADR 0057).
- Everything listed as incomplete in `2026-10-22-completeness-audit.md` is unchanged (live-provider verification, daily reminders, tracking, retention policy, backups, per-action rate limiting).

## Not covered

- Only the dispatcher role was used for the write flows; carrier-manager and driver write flows were not error-injected.
- Document upload, milestone changes, check-ins, exceptions, invoicing and invitations were not error-injected. They use the same client and idempotency helpers as the flows that were, but that is an inference, not a test.
- A slow network (long delays rather than failures) was not tested.
- Everything ran against the development server; the production build was not browsed.
- Organization and Audit log have no demo page, so they were reached only through the signed-in app.

## Verification

Lint, typecheck and `npm test` (301 / 301) pass. The full browser suite ran locally against the development server: 192 passed and 5 failed.

- Three of the five fail identically on the commit before any change in this series (`38e8c14`) and are properties of the development server, not of the code: the password-reset link page, the 4 MB bucket upload (needs CI's production server and fake bucket) and the Escape/focus test. CI, which runs the production build, does not list them.
- The phone accessibility test was the queue-strip gap above; fixed and passing 6 of 6.
- The inbox mark-unread test passes on its own and failed once in the full run: it depends on how much inbox data earlier runs left, and this session created a lot.

CI on `main`: the runs for `25c2d77` and `d0ffab7` passed; the run for `2e4ee37` (another session's commit) failed the browser step and the next run passed.
