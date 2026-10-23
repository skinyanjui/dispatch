# 0053 One page layout

Status: accepted, 2026-10-23. Extends ADRs 0051 and 0052.

## Context

A spacing audit of the demo's eleven pages (computed styles in a browser at 1280px) found the first block 12px from the panel edge on some pages and 16px on others, and between 8px and 28px between blocks (8, 12, 16, 20, 24, 28). Two causes:

- Pages spaced their blocks two ways: `gap` on the page root (Fleet, Exceptions) and outer margins on each block (`.stats`, `.tabs`, `.directoryIntro`, alerts). On Exceptions the two stacked, so a 16px gap measured 24–28px.
- The directory pages added 4px of padding-top on top of the workspace padding.

## Decision

- `src/app/page-layout.css` is the single page layout. A page root (`.carrierDirectory`, `.excPage`, `.fleetPage`, `.orgPage`, `.reports`, `.reportBody`) is a column with `gap: var(--page-gap)` (12px, `--space-3`) and no padding of its own, so the first block sits exactly at the workspace padding.
- Direct children of a page root have no outer margin. `.stats`, `.tabs` and `.directoryIntro` no longer carry margins in their own rules.
- A section heading (`h2`/`h3`) directly in a page root adds one `--page-section-step` (12px) above itself, so it is 24px below the previous block and 12px above its content.
- A new page uses one of these roots, or adds its class to the list in `page-layout.css`. Do not add vertical margins to blocks.
- Inbox, Assistant and the Loads board are full-height layouts with their own columns and are not page stacks.

## Verification and rollback

`tests/browser/page-layout.spec.ts` (demo, no database) checks the offset, gap and block margins on eight pages at 1280px and 390px. Rollback: remove the `page-layout.css` import from `layout.tsx` and restore the removed margins from git history (commit "One layout for every page").
