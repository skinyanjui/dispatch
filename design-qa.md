# Visual QA — Relay navigation and workspace

final result: passed

## Current source and adaptation

Primary visual target: the user's second Macro screenshot in this conversation, showing the light email workspace with an icon rail, contextual sidebar and a large main pane. Original image: 2880 × 1800; displayed by the client at 1996 × 1248. Browser chrome is outside the app target. Source CSS viewport and device pixel ratio are unknown. The first Macro Customers board screenshot remains the secondary target for stage columns and cards.

The user selected a minimal light workspace. Relay adapts the references to dispatch: load queues and a carrier membership directory occupy the shell; shipment stages remain authoritative server data. This is an inspired adaptation, not an exact pixel clone. Actual email, calendar and customer workflow behavior was not part of the requested freight scope.

## Implementation evidence

- `docs/audits/evidence/navigation-board.png`: desktop 1440 × 1000, authenticated seeded QA loads, Board view after filtering and loading.
- `docs/audits/evidence/navigation-carriers.png`: desktop 1440 × 1000, actual current carrier memberships.
- `docs/audits/evidence/navigation-mobile.png`: mobile 390 × 844 with drawer closed.
- `docs/audits/evidence/navigation-drawer.png`: mobile 390 × 844 with native navigation drawer open.
- Browser captures use deviceScaleFactor 1 and the production server. The reference and implementation were reviewed together in conversation context; no literal contact sheet or automated pixel-difference score is claimed. Unknown source density and different task content prevent pixel-level fidelity claims.

## Comparison and fixes

- The initial shell retained Next's developer badge at the bottom of the rail, obstructing Sign out during development (P2). Developer indicators were disabled; production captures also exclude the badge. The real logout flow passes.
- Earlier low-emphasis navigation and membership metadata was darkened (P2). Final captures were re-inspected for readability; no accessibility certification is implied.
- Carrier scope was initially visible only in the hidden mobile sidebar and Filter count (P2). The active carrier now appears as a removable chip in the work pane.
- No actionable P0/P1/P2 visual issues remain in the reviewed adaptation. P3: validate larger text and touch ergonomics with dispatchers on physical devices.

## Required visual surfaces

- **Typography:** restrained system sans-serif, compact labels, distinct main title and clear carrier names. Source font identification was unavailable. Long names truncate in the sidebar but remain readable in the directory/inspector. Card accessible names include carrier identity.
- **Layout and spacing:** desktop shell separates an icon rail, contextual sidebar and main pane. The main search field is rounded and controls are sparse. The sidebar can collapse. On phones, the rail remains while the sidebar becomes a native modal drawer. The board scrolls inside its container without document-wide overflow. Toolbar, sidebar labels, directory rows and card regions were inspected at readable scale in the saved captures.
- **Colors and tokens:** white surfaces, neutral borders and text, restrained mint actions and selected states. Shipment colors remain supplemental to text labels. This light palette follows the second reference; it intentionally supersedes the previous warm amber accent.
- **Asset quality:** real controls and editable text form the UI. Phosphor icons provide rail, sidebar and carrier iconography. No rasterized application or recreated browser chrome is used.
- **Content:** navigation labels describe supported load and carrier workflows. The directory reports session membership rather than claiming legal dispatch authority. Fictional QA identity is visible; no tracking observations are presented as live.

## Browser behavior and limits

Tested: stage and carrier filtering, repeated selections, sidebar collapse/restore, directory search/empty/clear/View loads, mobile drawer selection/closure, keyboard search, Board/List, create/assign/milestone/logout, dialog exclusivity, expired-session recovery, delayed/stale request recovery, gateway errors and idempotent retry. Final captures include JavaScript page-error and unexpected HTTP-resource checks. Local Playwright and installed Chromium provide browser-rendered evidence; no cloud browser connector is available.

Earlier design history and before/after screenshots remain in `docs/audits/2026-10-20-application-audit.md`. Latest source-backed findings and test evidence are in `docs/audits/2026-10-20-follow-up-audit.md`.
