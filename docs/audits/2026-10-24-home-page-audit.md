# Home page audit — 2026-10-24

Compared `/welcome` at 1440px (hero, product preview, cards, copy) with the signed-in Loads and Documents screens and the interactive demo.

## Found

1. **One load drawn in every stage** (QA-1042 in Booked, Dispatched, In transit and Delivered; QA-1043 twice), with "Docs 0/3" and "Docs 3/3" for the same load.
2. **Sidebar did not match**: plain text, no icons, 6 of 11 pages (no Contacts, Fleet, Prospects, Assistant, Reports), no search, New load, carrier list or account menu.
3. **Missing what makes the product distinctive**: queue strip, Board/Table/Calendar switcher with saved views, the "N loads need attention" bar, lane totals, and cards' pickup time, driver, paperwork count and plain-words warnings.
4. **Table and Calendar tabs were drawings that did not do what their captions said** (no sort, group or hide controls; days 1–21 with no month, and a load, QA-1040, that did not exist).
5. **Documents tab showed a chat bubble**, not the Drafts and Templates page with status pills.
6. **Copy overstated**: "Book, track and bill" (hero, page description, sign-in hero) and "Track and resolve" although Relay has manual check-ins only and no tracking; "a driver on each" although the board flags loads without one.
7. **Demo gap found along the way**: the interactive demo's Documents page had no data source (drafts and templates were not implemented in the demo adapter).

## Fixed

ADR 0060. The preview is built from the real components and the demo's data; the demo's Documents page works; copy says "record every step" and "Follow and resolve"; the sample-data note sits under the frame and says "real screens". Tests: `tests/browser/home-preview.spec.ts` (8), `tests/integration/demo-documents.test.ts`, and the phone checks in `marketing.spec.ts`.

## Not changed

- The preview shows the demo's four sample loads (one per stage), so lanes are short; a richer dataset would also change the demo.
- The preview's window cuts off at a fixed height (the real board scrolls), and its table is wider than the window on small screens.
- The "Everything in motion" headline is unchanged; it is a tagline, not a feature claim.
