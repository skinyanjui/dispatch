# 0061 One phone layer: type floor, 16px fields, 40px targets

Status: accepted, 2026-10-24.

## Context

The mobile audit (`docs/audits/2026-10-24-mobile-audit.md`) found that the app's compact desktop density carried onto phones: 8-11px text in 60 places, form fields at 11-15px (iOS Safari zooms the page when one is focused), and buttons, links and fields 21-32px tall. Earlier touch fixes (`system.css`) lost to the desktop rules' specificity, so for example the top bar's buttons stayed 28px tall.

## Decision

`src/app/mobile.css`, loaded last, applies at 800px and below and on any touch-first device (`pointer: coarse`):

1. **Type floor:** secondary text is 12px, chips and counters 11px. The selector list was generated from every sub-12px `font-size` in the stylesheets.
2. **Fields:** `input`, `select` and `textarea` are 16px (`!important`, because desktop sizes are set at many specificities).
3. **Targets:** buttons, summaries, selects, fields, tabs, and public-page header, footer, breadcrumb and table-of-contents links are at least `--touch-min` (40px). The `:not()` chain raises specificity instead of using `!important`. Inline text links inside sentences are exempt (WCAG 2.2).
4. Wide tables fade the edge that scrolls (`data-more` set by `DataTable`), a hidden "show all" button takes no row, and long button labels wrap.
5. At 360px and below the public header's links and the preview's tabs wrap or tighten so 320px screens do not scroll sideways.

`tests/browser/mobile-audit.spec.ts` enforces it at 320 and 390px on every public page and every dispatcher and driver page: no sideways page scroll, text at least 11px, fields 16px, controls at least 36px.

## Consequences

Desktop is unchanged. Phone screens are a little taller and denser text is larger. Adding a new small control on a phone fails the test until it is sized or exempted on purpose. Rollback: remove the import in `layout.tsx`.
