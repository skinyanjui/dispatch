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

## Open

- **Two banners for one failure.** When reads fail, the shell banner and the page's own banner both show the same message. Each now recovers with its own Retry, but one banner would be clearer.
- **Pages a role cannot open load data first.** A carrier manager or driver who opens `/audit`, `/organization` and similar addresses is sent to Loads with "We couldn't find that"; the page first fires its data requests (404s) before the role check. Harmless, but noisy and wasteful.
- **Typed work is lost on session expiry.** A dialog the person was filling in closes when they are sent to sign-in.
- **Edit conflicts have no in-dialog refresh.** The load dialog has "Refresh load details"; the vehicle, contact and other editors tell the person to refresh the page.
- **Inbox "find people" hides a failed search.** A failed lookup shows an empty list, which reads as "no matches".
- **Reports tile label wraps.** At about 1440px, "Delivered, no accepted POD" wraps to two lines, so the figures in the other tiles of that row sit one line lower to stay level with it. A shorter label would remove the gap.
- **No stuck-export signal.** An export whose background worker never starts stays "queued or running"; the failure is only a `console.error`. This is the existing observability gap (no metrics, alerting or dead-letter view).
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
