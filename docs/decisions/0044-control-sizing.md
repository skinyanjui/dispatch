# 0044 Control sizing and alignment

Status: accepted

## Decision

The signed-in app uses one size scale for interactive controls, defined in `src/app/controls.css` (loaded after every other stylesheet, so it settles the conflicts between the older ones):

| Token            | Size | Used for                                                              |
| ---------------- | ---- | --------------------------------------------------------------------- |
| `--control-h`    | 32px | fields, selects, buttons, search, tabs, sidebar items, queue pills    |
| `--control-h-sm` | 28px | toolbars, chips, and controls inside table rows or card action strips |
| `--control-min`  | 24px | the smallest allowed target (calendar events, footer links)           |

Phones keep 40px touch targets for icon buttons, text buttons and secondary links (`system.css` rules re-asserted at the end of the file).

Rules that go with the scale:

- **Dropdowns** hide the native arrow and draw one shared chevron 10px from the border, with 30px of right padding so text never runs under it.
- **Rows share a centre line.** A label that wraps a lone control inside a toolbar has no bottom margin. Rows that pair a captioned field with a button align to the field's bottom edge; rows without captions align to the centre.
- **Forms:** fields in one row share a top edge, and a field's note sits below it without moving its neighbour. A grid followed by a field has a 12px gap.
- **Tables:** header and cell text start at the same x; a status pill keeps its own height inside a table cell.
- **Carrier rows** use a fixed grid so the figures line up in columns from row to row.
- **Menus** float 8px clear of the control that opened them, close on an outside click or Escape, and on phones sit 16px inside the screen edges.
- **Sidebar search placeholders** are short enough to fit the 138px field.

## Consequences

CSS only: no schema, API or permission change. Rollback is removing the `controls.css` import. `tests/browser/layout.spec.ts` checks the invariants (dropdown arrow room, the three control sizes, toolbar centre lines, placeholder fit, header/cell alignment, form row tops, phone menus and touch targets) and fails without the stylesheet.

Not done: the public marketing and sign-in pages keep their own larger sizes (40–48px fields and buttons), and standalone text links inside sentences stay at their line height, which WCAG 2.2 exempts.

## Carriers page

Presentation only. The four filter tiles share a row and grow to fill it, left-aligned (they were centred and uneven), the sort select sits on its own right-aligned line above the list, and on phones the row actions fill the card. A carrier's role is shown only when the signed-in person has different roles on different carriers; a dispatcher who is a dispatcher everywhere no longer sees "Dispatcher" repeated on every row. Also: a Loads-page test now expands "Show all" in the carrier list, since accumulated QA data can push Blue Ridge below the six shown.

## Unused CSS removed

191 selectors that matched nothing were removed (about 710 lines across ten stylesheets): the old load-card layout, the old contact rows, the original top bar and filter panel, the driver card styles, the marketing step list that list items replaced, and similar. A selector was removed only if it names a class that appears nowhere in the app, tests or the static demo, and classes built from a prefix at runtime (`level-`, `sev-`) were kept. Rules that also named a class still in use lost only the dead selector. Method for next time: list every class in the stylesheets, drop those found in `src`, `tests` and `public`, and compare computed styles of every element on every main page at desktop and phone widths before and after. For this change 19,206 elements on 21 pages at two widths differed only by sub-pixel text widths (clock text, audit timestamps).

## Addendum: account tabs

The account page is split into Profile (name, phone, email) and Security (password, two-step verification) tabs, using the same tab pattern as Organization.
