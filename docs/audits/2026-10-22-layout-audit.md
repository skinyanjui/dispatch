# Component sizing and alignment audit — 2026-10-22

Scope: every signed-in page (Loads in board, table and calendar form, Exceptions, Inbox, Contacts, Carriers, Prospects, Assistant, Documents, Billing, Reports), the open menus (Filter, Options, account), the New load drawer, and the public pages, at 1440, 1024 and 390 px, as the dispatcher. A script measured every visible button, link, field, select and summary for height, row alignment, gaps, clipping and edge distance; screenshots were reviewed by eye.

## Findings (before)

| Check                                                                         | Count across the three widths                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| Dropdowns with the native arrow (about 8px from the border, text close to it) | 105                                                       |
| Flex rows whose children sit off a shared centre line                         | 58                                                        |
| Neighbouring controls closer than 4px                                         | 327 (most are the segmented controls' deliberate 2px gap) |
| Controls under 24px in either direction                                       | 137                                                       |
| Distinct control heights on the signed-in pages at 1440                       | 12 (21, 27, 28, 30, 32, 33, 34, 35, 36, 38, 40, 48)       |

Specific defects:

- **Loads toolbar:** "Default view" sat about 5px above Filter, Sort and Options because a global `label { margin-bottom: 12px }` pushed it up.
- **Loads table:** the "Load" header text started 7px left of the load references below it.
- **Carriers:** the figures (active loads, exceptions, drivers) shifted sideways from row to row with the width of the status pill; the Sort select arrow was hard against its border; on phones the "Dispatcher" label was indented 50px and the figures wrapped irregularly.
- **New load drawer:** Load reference and Agreed rate sat 1–2px apart vertically (`align-items: end`); "Booking source" had no gap above it; the time-zone select was shorter than the appointment field next to it.
- **Billing:** the filter pills touched the help line above and the count below; on phones a status pill stretched to the full cell height and its label sat 6px higher than the pill.
- **Reports and Billing toolbars:** the carrier select, segmented control and button were 2–8px off centre.
- **Sidebar search:** "Search conversations…", "Search invoices and loads…" were cut off mid-word.
- **Documents:** the chip row sat 2px under the tab underline.
- **Request access:** the email placeholder was clipped ("you@company.cor") and the terms checkbox was 46px tall, so it sat 14px below its text.
- **Menus:** on phones the Options menu could touch the screen edge; none closed on an outside click or Escape.
- **Calendar events** were 21px tall.

## Changes

`src/app/controls.css` (ADR 0044) sets one size scale (32 / 28 / 24px), one dropdown arrow, one centre line per toolbar row, fixed columns for the carrier figures, and the specific fixes above. Search placeholders were shortened and the Request access checkbox size and email placeholder fixed in `login.css` and `request-access.tsx`. A regression I introduced while doing this (10px side padding on every field clipped the sidebar search) was caught by the placeholder check and fixed before the commit.

## Result (after)

- Native-arrow dropdowns in the app: 105 → 0. The public demo's "Dispatcher view" select, the one remaining, now uses the same arrow (not re-measured).
- Off-centre flex rows: 58 → 4, all intended or false positives (the Assistant composer aligns its button to the bottom of the textarea; Inbox tabs wrap onto a second line on phones).
- Clipped placeholders: 7 → 0.
- Control heights at 1440: 12 sizes → the 28px and 32px scale (573 and 324 of the app's controls); the rest are cards, tiles, the skip link and the account button, which are content, not controls.
- Remaining small targets are inline links in sentences (exempt under WCAG 2.2), the sidebar search input (its 32px wrapper is the target) and table text links.
- Verification: lint, typecheck and build pass; browser suite **115 / 115** (4 new in `tests/browser/layout.spec.ts`, which fail when `controls.css` is removed). Integration tests were not affected (no server code changed) and were not rerun.

## Not done

- Native dropdown option lists are drawn by the browser and cannot be styled or positioned from CSS.
- Marketing and sign-in pages keep their larger sizes.
- Checked in Chromium only; Safari and Firefox render form controls differently and were not tried.
- No screen-reader or zoom (200–400%) pass.
