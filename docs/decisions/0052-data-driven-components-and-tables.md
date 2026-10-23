# 0052 Data-driven components, one table and one token file

Status: accepted, 2026-10-23. Extends ADR 0051. The full standard is `docs/design-system.md`.

## Context

An audit of `src/components`, `src/app/*.css` and the pages that use them found:

- **Tables:** ten raw `<table>`s in seven files, each with its own markup and CSS. Five of them turned rows into phone "cards" that repeated every column name in every row (`td::before { content: attr(data-label) }`, 51 places). The Carriers and Exceptions pages were card lists that also repeated their field names in each card.
- **SVG:** a hand-written SVG column chart (Reports), and the dropdown arrow drawn as an SVG data URI.
- **Repeated feedback markup:** about 60 hand-built error alerts, 11 empty states with three heading levels and three class names, and 9 page intros.
- **Date formatting:** seven identical local copies of a date helper, plus about 25 other ad-hoc date formats.
- **Tokens and colours:** tokens were defined in six stylesheets that overrode each other (the control height was set to 34, 30 and 32px in turn). The same stage had two colours (board dots and queue pills), and about 180 raw colours were scattered across page stylesheets.
- **Unused code:** about 40 unused imports and variables, because the lint config did not check for them.

## Decision

- **`DataTable<T>`** (`components/ui/data-table.tsx`) is the only table.
  - A typed `ColumnDefinition<T>` (header, accessor, type, alignment, width token, sort, priority, row header, render) drives the header, every cell, sorting and formatting.
  - It handles sorting (controlled or internal), groups, client paging, row opening, footer rows, and the loading, empty and error states.
  - Every listing uses it: Reports (2), Fleet (2), Documents, Audit log, Billing (2), the Loads table, Carriers, Exceptions and the marketing preview.
  - On narrow screens it scrolls sideways with the row's name held in place, and hides `priority: "low"` columns under 640px. It never repeats a column name in a row.
- **No hand-built SVG.**
  - `BarList` (a native `meter` per row) replaces the SVG column chart.
  - The dropdown arrow is two CSS gradients.
  - Icons come from Phosphor. `public/favicon.svg` remains as a static logo.
- **Feedback components** (`components/ui/feedback.tsx`):
  - `ErrorAlert` (with Retry and a polite option), `EmptyState` (page or inline) and `PageIntro`.
  - `DataTable` uses `ErrorAlert` and `EmptyState` itself.
- **`StatusBadge`:** one status pill with a typed tone. Its colours are status tokens.
- **Formatting:**
  - `lib/format.ts` is the one place values are formatted for display. Its core is `formatInstant`, configured by which parts to show and an optional time zone, with presets on top.
  - No component calls `toLocaleString`.
- **Tokens:**
  - `src/app/tokens.css`, loaded first, holds every token, scoped to global, app, sign-in and marketing, with the final effective values.
  - New tokens: stage colours (shared by queue pills and board lanes), `--warn*`, `--accent-tint`, skeleton, shadow, `--star` and `--select-arrow`.
  - No stylesheet but `tokens.css` has raw colours. The spacing and control scale is global, so public pages that used it resolve it.
- **Guards:**
  - `scripts/check-design-system.mjs` runs in `npm run lint`. It fails on:
    - inline SVG and inline styles (except `global-error.tsx`)
    - raw tables, `data-label` and hand-built tab lists
    - hand-built alerts, empty states and intros
    - hand-formatted dates
    - any raw colour outside `tokens.css`, and any use of an undefined token
  - ESLint now fails on unused variables and imports.

## Consequences

- Presentation, markup and tooling only: no API, schema, permission or data change.
- Visible changes:
  - Phone tables scroll instead of stacking.
  - Carriers and Exceptions are tables with sortable headers, and their separate sort select is gone.
  - Stage dots on the board use the queue-pill colours.
  - Weekly loads in Reports are horizontal bars.
  - The app breadcrumb uses the muted text colour, the directory search icon uses `--subtle`, and the Loads calculation row uses `--ink` (it referred to an undefined `--text`).
  - Inbox timestamps use the app's fixed US English format instead of the browser's locale.
- About 200 dead selectors were removed, and the browser tests were updated to the new markup (headers, row headers, "Show more").
- **Remaining exceptions:**
  - Kanban and load cards, chat messages and the record's field list are not tables. They name values with icons or position, or are a single record.

Rollback: revert the commits; no data migration is involved.
