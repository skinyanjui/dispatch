# 0051 Shared UI components for tabs, filters and figures

Status: accepted

## Context

Pages built their own tab strips, filter chips, option pickers and summary tiles inline. There were five tab implementations, four chip and picker variants, and six tile styles. Each had its own CSS, and several made the selected item bolder than the rest. That widened it and pushed its neighbours sideways. Other strips moved for the same kind of reason: a link appearing in a chip row, a page action appearing above the tabs, or date fields taller than the controls beside them.

## Decision

Pages use components from `src/components/ui`, styled once in `src/app/ui.css` (loaded last) on the control scale of ADR 0044:

| Component | Use | Pages |
| --- | --- | --- |
| `Tabs`, `TabPanel` | Switch the panel below (WAI-ARIA tabs: one tab stop, arrow keys, Home, End) | Account, Organization, Documents, Billing, load record, marketing preview |
| `ToggleGroup` variant `chips` | Filters with a count | Loads attention, Billing invoice and freight filters, Documents drafts, Prospects follow-ups |
| `ToggleGroup` variant `segmented` | Pick one option | Loads layout, Reports date range, Inbox send-via |
| `ToggleGroup` variant `folders` | The Inbox rail where the sidebar does not list folders | Inbox |
| `StatTiles`, `StatTile` | Summary figures, optionally a filter (`pressed`) or a link (`actionLabel`) | Billing, Reports (KPIs, pipeline, billing), Carriers, Exceptions, Fleet |
| `ColumnChart` | Small column chart drawn in SVG | Reports |
| `.countBadge` | A count beside a tab, heading or menu label | everywhere |

Rules that go with them:

- Selection shows by colour, underline or background, never by a heavier weight. Pressing an item never moves the items beside it.
- A tab's own action, such as "New template", sits at the top of its panel (`.panelToolbar`), not above the tab strip.
- A control that appears only in some states, such as "Show all loads", keeps its place while it is hidden.
- Components have no inline styles. Data-driven sizes are SVG attributes, and colours come from classes.

## Consequences

Presentation and markup only: no API, schema or permission change. About 100 old selectors were removed (`orgTab`, `billingTab`, `attentionChip`, `inboxTab`, `reportTile`, `carrierStat`, `excTile`, `fleetTile`, `pipelineStep`, `weekChart`). Summary tiles now read label first everywhere. The load record's tabs use arrow keys instead of Tab, as the tabs pattern requires.

Also fixed in this pass:
- The load record's left column was sized to its widest child, so the driver row and the next-step button ran out of the panel. The next-step button now names the stage only once a driver is assigned.
- The Reports custom range kept the row at control height.

`tests/browser/controls.spec.ts` clicks every tab, chip, segment, folder and queue pill on Loads, Account, Organization, Documents, Billing, Reports, Prospects and Inbox at 1440 and 390 px. It fails if any strip moves vertically, changes height, or if an item moves within its strip. Rollback: revert the commit.
