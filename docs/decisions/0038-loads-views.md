# 0038 — Views on the Loads page

## Context

Dispatchers work the same loads in different ways: a board by stage, a sortable table, a calendar of appointments. A review of how Twenty CRM describes table, kanban and calendar views (ADR 0036; ideas only, no code) showed the pattern worth having: a view is a saved choice of layout, grouping, sort, visible fields and filters.

## Decision

- **Layouts:** Board (default), Table and Calendar, chosen on the Loads page. Drivers keep the board only.
- **Board:** each column shows a count and the freight total; a Compact option hides card detail; a card can be **dragged to the next column**, which records the same milestone as the drawer button. Skipping a step, dropping on a load with no driver, or dropping on a cancelled load is refused with a reason. Delivery rules stay on the server (version check, dispatch authorization); drag is only a shortcut, and the drawer button remains the keyboard path.
- **Table:** sortable columns (`aria-sort`), optional grouping by stage or carrier with collapsible groups that show a count and freight total, and per-field visibility.
- **Calendar:** a month grid placing loads by next appointment or created date, with Today and month navigation, "+N more" per day, and a note of loads without a date. The data is the already-loaded page of loads; it is not a new query.
- **Saved views** (`saved_views`, migration 033): private by default or shared with the owner's organization; only the owner updates or deletes. A view stores display choices and filters (stage queue, carrier) only, never records, so opening a shared view can never show anything the viewer's own access does not allow. Config is validated strictly on the server. No audit rows (display preferences).

## Not done

Field reordering by drag, other aggregations (average, min, max), calendar week/day layouts, views for other pages, and a server-side query for the calendar beyond the loaded page.

## Rollback

`saved_views` is additive and the layouts are client-side; reverting the client restores the board. The table can stay unused.

## Responsive pass (phones)

CSS plus one small component addition; no API or schema change. On phones: the stage pills scroll under a soft edge instead of being cut off; the layout switch fills its row and the saved view and Filter, Sort and Options fill the next; the three attention counts share one row under their title; board stages are 86% of the screen wide with the next stage peeking and snapping; the table keeps its load column pinned while the rest scrolls; and the calendar, whose month grid is unreadable at that size, is a list of days with their loads (the grid returns from 641px up). Rollback: revert the commit.
