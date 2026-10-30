# 0075 Floating public navigation

Status: accepted, 2026-10-30. Supersedes the header and menu parts of ADR 0063 (the logo rules there stand).

## Context

The public header was a full-width bar whose mega menu was a full-width slab under it, and the phone menu was a full-height sheet. Menus had nine and seven entries with overlap (Authorize, Paperwork and Bill appeared in both Product and How it works), and a menu opened by hover could not be reached by Tab.

## Decision

- **A floating, sticky bar.** `.mkBar` is a transparent sticky strip; `.mkHeader` inside it is a rounded, softly blurred bar inset from the edges and from the top, aligned with the page's 1080px column. The strip lets clicks through to the page.
- **Simple dropdowns.** Each panel is a small rounded card under its trigger: group titles and link labels only, no descriptions, feature card or pictures (the demo is listed once, under Resources). It opens by hover (mouse only), click or ArrowDown; a click pins it. It closes with Escape (focus returns to the trigger), an outside click, focus moving out of the menu, leaving it, or following a link. A short bridge keeps the pointer inside while it crosses the gap.
- **Reachable by keyboard.** A panel is rendered directly after its trigger, so Tab moves into its links and on to the next trigger.
- **Phone: a card that opens over the bar.** Below 900px the bar shows the logo and one menu button. The button opens a native modal `<dialog>` styled as a rounded card in the bar's position (focus trapped, Escape closes, page scroll locked). It holds one exclusive accordion (`<details name>`), labels only, and a primary "Request access" with "Sign in" beneath. It closes itself if the window grows past 900px.
- **Regrouped content.** `src/lib/marketing-menu.ts` still feeds both menus. Product is Run dispatch and Keep records; How it works is the six steps in two groups; Resources is Know the limits (what it does not do, where Relay is today, AI) and Try and trust (demo, terms, privacy). Every previous link target is kept, and the browser test still follows each one.
- Motion is a 140ms fade and is off under `prefers-reduced-motion`.

## Consequences

Anchors land 96px below the top so the bar never covers a heading. The backdrop blur falls back to a solid bar where unsupported. `<details name>` needs a current browser; elsewhere several groups can be open at once, which is harmless. Rollback: restore `marketing-nav.tsx`, `marketing-nav.css`, `marketing-menu.ts` and the `.mkBar` rules in `marketing.css` from the commit before this one; no data is involved.

## Colours

Audited 2026-10-30. Every colour in the bar, dropdowns and phone card comes from a token; the bar's translucent white and its two shadows are new `.mk` tokens (`--mk-bar`, `--mk-shadow-bar`, `--mk-shadow-card`), and the phone backdrop uses `--backdrop` instead of the navy `--ink` at reduced opacity. Contrast (WCAG 2.2 AA, 4.5:1): `--mk-ink` on white 17.0, on `--mk-soft` 15.9; `--mk-muted` on white 7.5, on `--mk-soft` 7.0; `--accent` text on white 6.1; white on the `--accent` button 6.1 (7.5 on hover). The 1px bar and card borders (`--mk-line`) are decorative; the shadows and fill separate the surfaces. Summary rows in the phone card gained a visible focus ring (`--focus`), which the global rule did not cover.

## Brand colour and the app audit (2026-10-30)

The logo is now a white stack icon on a rounded `--accent` tile (`.brandMark`, sized in `em` so it scales in the sidebar, phone bar, public bar, footer and sign-in hero) beside the ink wordmark and blue period. It is the one coloured note in the otherwise neutral app; white on the tile is 6.1:1. The sign-in hero rule that tinted the icon blue is removed, since blue on the tile would vanish.

The signed-in sidebar and the demo banner were audited with the same method and needed no colour change: item text `--ink` on the canvas 11.4, on the active row 10.1; `--subtle` labels and icons 5.7 on the canvas, 5.3 on hover, 5.0 on the active row; the blue active icon 4.8 on the active row (3:1 needed for icons); the demo banner's `--muted` 11px note 6.6 and blue link 5.4 on `--accent-soft`. Not run here: the signed-in pages need a seeded database, so the sign-in hero was checked by contrast only, not by screenshot.
