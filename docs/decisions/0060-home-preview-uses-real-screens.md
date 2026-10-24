# 0060 The home-page preview uses the real screens

Status: accepted, 2026-10-24.

## Context

The product preview on `/welcome` was hand-drawn markup with its own sample values. It had drifted from the app: it drew one load in all four stages, showed six sidebar pages instead of eleven, omitted the queue strip, view switcher and attention bar, drew a calendar with no month, and a Documents tab that looked nothing like the Documents page. The hero also said "track" although Relay records manual check-ins only.

## Decision

- The preview renders the app's own components (`Board`, `LoadCard`, `QueueTabs`, `LoadsViewBar`, `AttentionStrip`, `TableView`, `CalendarView`, `DocumentsPage`) inside the real `appShell` styles. Its sidebar reads the same `workspacePages` list and `sectionAllowed` rule as the signed-in sidebar.
- Data comes from the interactive demo's fictional adapter, created with `persist: false` so the preview never reads or writes the demo's saved state. The preview is decorative: `inert`, `aria-hidden`, labelled "The real screens with fictional sample data, not live data."
- The demo gains read access to document templates and drafts (and Mark as reviewed / Discard), built with the server's own `render` and merge-field list (now in `draft-fields.ts`), so its Documents page works. Creating or editing templates, and PDF download, stay unavailable in the demo.
- Copy no longer says "track": the hero reads "Book freight, record every step and bill separately for your carriers".
- `tests/browser/home-preview.spec.ts` compares the preview's pages and queues with the real workspace in the demo, requires four named stages and no load drawn twice, checks it is inert, leaves demo storage untouched, has no axe violations at 1440 and 390px, and bans tracking claims in the hero and cards.

## Consequences

The preview cannot drift in structure or styling: a change to a card, the sidebar or a page is a change to the drawing. The marketing bundle now includes those components. Rollback: restore the previous `product-preview.tsx` and marketing CSS; the demo changes are independent.
