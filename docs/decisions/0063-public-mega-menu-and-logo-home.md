# 0063 Public mega menu, phone menu, and where the logo goes

Status: accepted, 2026-10-24. The header, mega menu and phone menu are superseded by ADR 0075; the logo rules stand.

## Context

The public header was four links in a row that wrapped awkwardly on phones, and the logo was inert inside the app. AGENTS.md and ADR 0039 give the signed-in app one sidebar in which each page is listed once.

## Decision

- **Public site:** `src/components/marketing-nav.tsx` renders a mega menu from 900px (Product, How it works, Resources; Get started and Pricing stay plain links) and a full-height sheet below it (a native modal `<dialog>` with an accordion, so focus is trapped and Escape closes it). Both read one list, `src/lib/marketing-menu.ts`. The menu opens by click, hover or ArrowDown, closes with Escape (returning focus to its trigger), an outside click, leaving it, or following a link. Each panel shows a picture of the product (the same state pictures as the explainer pages) beside a call to action. Links point at #sections of real pages; a browser test follows every link and checks its page and section exist.
- **Logo, public:** always the public home (`/welcome`), from every public page, the sign-in screen and the footer.
- **Logo, in the app:** a button that goes to the page the person uses most (`src/lib/most-used.ts`). Visits are counted per signed-in user in that browser's local storage only, never sent anywhere, with older visits fading (each new visit multiplies the earlier ones by 0.95) so a change of habit wins within a couple of weeks. Fewer than three visits, a page the person may not open, and utilities (Account, Notifications, Organization, Audit log) never count; the fallback is Loads. Its accessible name and tooltip say where it goes ("Relay, go to Inbox").
- **The app gets no desktop mega menu.** Its sidebar already lists every page once (ADR 0039), and a second listing would break that rule; the phone menu already exists as the same sidebar in a drawer, and the logo now sits in it too.

## Consequences

The most-used page is per browser, not per person across devices; a server-side tally would need a table and a privacy decision. The public header is client code. Rollback: restore the previous `marketing.tsx` header and `Brand` usages; `most-used.ts` is independent.

## Follow-up (CI)

A menu opened by hover is pinned by the click that follows it; before, that
click toggled it shut, because the pointer is already over the trigger. Only a
click on a pinned menu closes it.

CI start-up: the Content-Security-Policy is built per request (ADR 0058), so the
browser job passes `RELAY_CSP_CONNECT_EXTRA` to `npm start`, not to the build.
The Scheduler workflow now runs and prints a notice when `RELAY_JOBS_URL` is
unset instead of being silently skipped.
