# Mobile audit — 2026-10-24

Method: a script visited every public page and every app page as dispatcher, carrier manager and driver at 320, 360, 390, 430 and 768px (touch enabled) and measured, per page, sideways page scroll, elements outside the screen, controls under 36px, form fields under 16px (iOS zooms the page on focus) and text under 11px. Then screenshots of the main screens and the dialogs (navigation drawer, new load, load sheet) at 390px, and a landscape check (844x390). Development server, fictional data. It cannot judge taste or real devices.

## Found (before)

| #   | Finding                                                                                                                                                                                                                                                                             | Scale                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | The public header's four links ran 22px past a 320px screen (all marketing pages); the preview tabs did too                                                                                                                                                                         | every public page at 320px                       |
| 2   | Form fields at 11-15px, so iOS Safari zooms the page when one is focused                                                                                                                                                                                                            | 90+ selects, many inputs                         |
| 3   | Text at 8-10px: the page footer ("Updated 3:15 PM") at 8px, toolbar counts at 9px, table headings and badges at 10px                                                                                                                                                                | 60 selectors                                     |
| 4   | Controls 21-33px tall: the top bar's menu and New load buttons (28px, despite an earlier 40px rule that lost on specificity), queue and view tabs, chips, selects, sort buttons, count buttons (10px wide), the public header, footer, breadcrumb and legal table-of-contents links | about 250 links and 380 buttons across the sweep |
| 5   | A blank 40px row in the attention bar on Loads (the hidden "show all" button wrapped onto its own row)                                                                                                                                                                              | Loads, phones                                    |
| 6   | The new-load form's "Turn on AI reading…" button ran out of its box                                                                                                                                                                                                                 | new load, phones                                 |
| 7   | Wide tables (fleet, carriers, billing, loads table) scroll sideways with nothing saying so; the Status column is cut off mid-word                                                                                                                                                   | every table                                      |
| 8   | About 90 lines of dead CSS for the old hand-drawn home-page preview                                                                                                                                                                                                                 | marketing.css                                    |

## Fixed (ADR 0061)

`src/app/mobile.css`: type floor, 16px fields, 40px targets, and the fixes for items 1, 5, 6 and 7 (tables fade the edge that scrolls, set by `DataTable`); the dead CSS is removed. After: the sweep finds nothing at all five widths; `tests/browser/mobile-audit.spec.ts` (8 tests) holds it at 320 and 390px and fails without the layer.

## Checked and fine

Viewport meta (Next.js default), no sideways page scroll after the fixes at any width including 320, dialogs and the load sheet fit and scroll, landscape (844x390) has no overflow, the board scrolls sideways with the next stage peeking in, the navigation drawer and account menu fit.

## Not covered / still open

- Real devices, real keyboards (the on-screen keyboard shrinking dialogs), Safari quirks, zoom to 200%, and screen-reader gestures were not tested; only Chromium emulation.
- Tables still scroll sideways on phones instead of becoming cards (a deliberate earlier decision: ADR on the data table). The edge fade now signals it; the Status column of Fleet and the Dispatch authorization column of Carriers are still off-screen until scrolled.
- No `viewport-fit=cover` or safe-area padding, so on notched phones in landscape content can sit under the notch edge only if the browser extends the page there; it does not by default.
- The touch targets are 40px, under the 44px that Apple's guidance recommends; they meet WCAG 2.2's 24px minimum.

## Follow-up: menus (2026-10-24, ADR 0063)

The public header's four wrapping links are now a mega menu from 900px and a modal sheet below it (menu button, accordion groups, Request access and Sign in at the foot); every menu link is checked against a real page and section. The logo goes to the public home on public pages and sign-in, and to the person's most used page inside the app (Loads until there is a habit; counted in this browser only). Tests: `tests/browser/navigation.spec.ts` (7), `tests/integration/most-used.test.ts` (4).
