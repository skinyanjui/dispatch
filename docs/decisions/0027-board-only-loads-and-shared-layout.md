# 0027 — Board-only loads and a shared layout system

Status: accepted, 2026-10-21.

## Decision

- **Loads are shown as a board only.** The list view and the Board/List toggle are removed for every role. Drivers see the same board of their assigned loads and keep their empty state. Cancelled loads carry a "Cancelled" badge on their card and are listed under the Cancelled queue.
- **Search, filter, count and refresh share the page header row** on the loads page; the page title stays in the DOM for screen readers only. Other pages keep a visible title.
- **One layout stylesheet, `src/app/system.css`,** is loaded last and scoped to `.appShell`. It defines a 4px spacing scale (`--space-1…6`), one control height (34px) and radius (8px), one page-intro row, equal side padding for the header and content at every width, non-wrapping buttons, and the shared shapes for search fields and inline filter checkboxes. Selects keep the browser's native arrow; icons come from the icon library, never hand-written SVG.
- **Inbox** uses one toolbar row (search, channel, unread, New message) above two panes that fill the page and scroll independently; thread rows align icon, title and time in fixed columns.
- Alignment is guarded by a Chromium test that compares each page's title and first block with the content column on desktop and phone widths, and checks there is no horizontal overflow.

## Consequences

No data, API or migration change. Older per-page stylesheets still define their original rules; `system.css` overrides them, so new pages should use the shared classes instead of adding further overrides.

## Rollback

Remove the `system.css` import to restore the previous styling; the board-only change is a UI revert of `dispatch-workspace.tsx`.
