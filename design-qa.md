# Visual QA — Relay light workspace

final result: passed

## Reference and intended adaptation

Source visual truth: the user's attached macro.com Customers board screenshot in this conversation (2550 × 1520 original pixels; displayed by the client at 2048 × 1221). It is visible as the user-provided reference, rather than a local file. The user selected **Minimal light workspace** before providing the screenshot. This is an inspired adaptation, not a pixel-accurate clone: dark colors become warm light neutrals, four shipment stages replace five customer stages, and actual carrier/route/rate information replaces customer websites. No claim is made about unseen macro.com screens.

Implementation evidence: `docs/audits/evidence/after-board.png` captured at CSS viewport 2550 × 1520 and deviceScaleFactor 1, plus `after-board-desktop.png` at 1440 × 1000 and `after-mobile.png` at 390 × 844. Inspector and create-state evidence are `after-details.png` and `after-create.png` at 1440 × 1000. User reference and browser captures were reviewed together in conversation context; no literal side-by-side contact sheet or automated pixel score was produced. The reference device pixel ratio/CSS viewport are unknown. Different themes and content make pixel-difference metrics inappropriate.

## Findings and comparison history

- The first before/after capture attempt showed an updating queue and the developer compile badge. That capture was rejected as final evidence. Production captures replaced it after the queue reported six matching loads.
- Small operational metadata initially had insufficient visual emphasis against the pale surface (P2). Secondary operational colors were darkened and help/carrier text increased to 11 px; final production screenshots were re-inspected.
- The mobile footer initially concatenated its two status phrases (P2). The separator is now retained; recapture confirms visible separation.
- Search's keyboard hint was initially included in its accessible name (P2). It is now aria-hidden. Filters have explicit accessible select names, and browser tests cover keyboard search, filtered queue, and session recovery.
- No remaining actionable P0/P1/P2 issues in the reviewed adaptation. Future polish: test touch ergonomics and larger text preferences on physical devices (P3); inspect all typography with a dispatcher before release.

## Required surfaces

- **Typography:** neutral system sans-serif, compact controls, medium card titles and distinct secondary metadata. Exact source font identification was not available. Truncation is deliberate for long references, with full text available in the inspector/title. Iconography is the Phosphor icon library, with decorative icons hidden from accessible names.
- **Spacing/layout:** compact title and Board/List switch above a filter/search toolbar. Equal-width bordered columns, small card gaps, restrained radii and card elevation reproduce the source's structure. Deliberately larger route sections carry freight details. Focused toolbar/card and inspector regions were inspected in the full-resolution captures; they are readable at their captured size. At 390 px, board lanes scroll internally and persistent controls stay within the page width.
- **Colors/tokens:** warm white canvas/panels, neutral text and borders, amber create action. Purple, amber and green are secondary stage cues; text labels carry the state independently of color. Light theme is intentional rather than source drift.
- **Images/assets:** no photographic or custom illustrated content is needed for this freight adaptation. Original raster prototype previews remain separate; all operational UI is real text, controls and library icons. No screenshot is used as the application interface.
- **Copy/content:** actual load reference, authorized carrier, route and exact USD rate replace customer names/sites. No unused CRM stages, fabricated tracking, decorative fake commands or live integration claims were added. Board/List, filters, search and refresh are functional.

## Browser evidence and limits

Primary interactions tested: sign-in, Board/List switch, filters, Command/Ctrl+K search focus, load inspector, create with exact dollar/time-zone entry, assignment, milestone, dialog Escape/close, session expiry, lost-response retry and logout. JavaScript page-error collection during final production capture was empty. Console/resource review found the expected anonymous /api/me 401 and a missing favicon; a library-derived favicon was added and rechecked. Both production browser tests and responsive capture passed. No cloud-browser connector exists in this environment; the actual application was verified with local Playwright and installed Chromium. This does not establish accessibility compliance or exact macro.com fidelity.

Implementation checklist completed: capture the user reference, adapt its structure to light theme, replace the old dashboard, preserve server-backed workflows, fix the listed P2 issues, re-capture stable production screens, run functional gates and record remaining risks.
