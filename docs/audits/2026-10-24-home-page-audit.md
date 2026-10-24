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

## Follow-up: removing what did not earn its place (2026-10-24)

- **Closing banner removed.** "Try it with sample data" repeated the hero's two buttons and the header's Request access. The page now has one Request access in the page body (hero), one demo link, and the sticky header's button.
- **"Look at your loads the way you work" removed.** It described Board, Table and Calendar a second time, directly under a drawing that shows them with their own tabs. The one fact it added (views can be saved for yourself or your organization) is now in the Table caption.
- **Footer no longer repeats the header's four links** (Product, How it works, Get started, Pricing). It keeps what the header lacks: the interactive demo, Terms and Privacy.
- **Vacuous sentence removed** under "Boundaries enforced in the product" ("Relay enforces the limits of dispatching other people's freight" restated its heading), along with the guardrail "Tracking is never presented as live", which defended a feature Relay does not have and repeated the "Follow and resolve" card ("check-ins show their source and time"). The remaining two guardrails use different icons instead of three identical shields.
- **Duplicate wording trimmed:** "fictional sample data" was in the preview note and again in the status band; "Nothing is sent" in the Documents caption and again in the assistant section.
- Guarded by `tests/browser/home-preview.spec.ts` (one Request access in the page, no closing banner, no footer copy of the header links, no repeated section headings).

## Same pass on the other public pages (2026-10-24)

- **All three inner pages (How it works, Get started, Pricing):** the eyebrow above the title repeated the active nav tab and the breadcrumb, and each ended with a banner repeating Request access and the demo. Both removed; the banner component and its CSS are deleted. How it works keeps one demo link in its opening line; Get started keeps its single "Open the request form" step; Pricing keeps the card's button.
- **Pricing said each thing two or three times.** "Free" and "early access" appeared in the title, the card name, the price and its note; "no payment details" in the footnote and an assurance; "before any charge" in the lead, an assurance and the FAQ; "AI off by default" in the feature list, an assurance and the FAQ; "who can join" in the card and the FAQ. Now: title, one lead promise, the card (no badge, no price note, no "everything below" sentence, since the column is labelled "Everything included"), one footnote, and one assurance carrying the unique fact (AI is billed to your own account, with a monthly limit). The FAQ is gone.
- **Terms and Privacy** ended with "Back to sign in", duplicating the header's Sign in. Removed.
- **Request received** no longer says "Thanks. Relay is invitation-only" before explaining the review; it opens with what happens next.
- Guarded by `tests/browser/public-pages.spec.ts`.
