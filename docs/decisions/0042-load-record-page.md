# 0042 Load record page

Status: accepted

## Context
The load "drawer" stacked every section (route, check-ins, documents, exceptions, notes) in one long scroll. The grey-frame look (ADR 0039) calls for a record page: a fields panel beside tabbed activity.

## Decision
- Keep the same `Load details` dialog and API, so focus handling, Escape behaviour and all server contracts are unchanged. Only the layout changes.
- Left panel: reference, added date, stage, fields (carrier, agreed rate, booking source, pickup, delivery), driver assignment, milestone and message actions.
- Right side: a breadcrumb (Loads / reference) and tabs Timeline, Route, Check-ins, Documents, Exceptions and Notes (Notes hidden from drivers, as before). Counts come from data already loaded; no new requests.
- Tabs use `role=tablist/tab/tabpanel`. The selected tab resets to Timeline when a different load opens and is kept when the same load is refreshed.
- On phones the record is full screen with a single column.

## Consequences
No schema, API or permission change; rollback is reverting the commit. Browser tests now select a tab before touching a section. Twenty's "Tasks" and "Files" tabs are not copied: Documents already covers files, and there is no task object yet.
