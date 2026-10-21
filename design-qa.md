# Visual QA — Relay global design and operations

final result: passed

## Compact shell revision — 2026-10-21

The user asked for compact components, better font weights, lower cognitive load, and a Claude-inspired sidebar with smaller icons and no duplicated pages.

- **Before:** the icon rail repeated four sidebar pages; the sidebar held 11 entries plus stage queues and every carrier; the top bar repeated Create load, a breadcrumb and a QA badge; text went down to 9px.
- **After:** one sidebar with 16px icons. Each page is listed exactly once, and the same items stay as icons when collapsed. Queues and carriers appear only on Loads, capped at six with "Show all". Settings and Sign out live in the account menu. New load lives only in the sidebar (and as a single + in the phone header, where the sidebar is hidden). Text is at least 11px, weights are 400/500/600, controls are about 32px tall, and board cards show the route on one line.
- **Evidence:** `docs/audits/evidence/compact-*.png` — desktop expanded, collapsed, account menu, load inspector, phone and phone navigation. 45 Chromium tests pass, including a test that each page appears once in both sidebar states. Phone layout keeps `scrollWidth` within the viewport.
- The Macro notes below are kept as history.

## Current source and adaptation

Primary visual target: the user's second Macro screenshot in this conversation, showing the light email workspace with an icon rail, contextual sidebar and a large main pane. Original image: 2880 × 1800; displayed by the client at 1996 × 1248. Browser chrome is outside the app target. Source CSS viewport and device pixel ratio are unknown. The first Macro Customers board screenshot remains the secondary target for stage columns and cards.

The user selected a minimal light workspace. Relay adapts the references to dispatch: load queues and a carrier membership directory occupy the shell; shipment stages remain authoritative server data. This is an inspired adaptation, not an exact pixel clone. Actual email, calendar and customer workflow behavior was not part of the requested freight scope.

## Implementation evidence

- Latest onboarding captures: `docs/audits/evidence/onboarding-company.png`, `onboarding-agreement.png` and `onboarding-team.png`, each production desktop 1440 × 1000. These use real local APIs and fictional QA records; private invitation tokens and passwords are not displayed.
- `docs/audits/evidence/onboarding-join-mobile.png`: production mobile 390 × 844, private-invitation activation with optional fields collapsed.
- `docs/audits/evidence/onboarding-driver-mobile.png`: production mobile 390 × 844, focused assigned-load cards in the current sandbox.
- `docs/audits/evidence/demo-current-desktop.png`: production desktop 1440 × 1000, shared application UI with the fictional-data banner and role selector. The current `/demo` uses the application components; the independent historical prototype remains at `/legacy-demo.html`.
- `docs/audits/evidence/global-login.png`: production desktop 1440 × 1000, access guidance expanded; empty password field.
- `docs/audits/evidence/global-create.png`: production desktop 1440 × 1000, shared create dialog and mint action.
- `docs/audits/evidence/manual-check-in.png`: production desktop 1440 × 1000, inspector scrolled to manual report and expanded entry form.
- `docs/audits/evidence/manual-check-in-mobile.png`: production mobile 390 × 844, report provenance and entry form.
- These latest captures use an isolated carrier-manager session and a unique fictional `VISUAL-` QA load, with a manual Joliet observation and Casey Lane as the authenticated reporter. The edited Kankakee form is an unsaved draft. All data is explicitly fictional, sourced through actual local APIs rather than stubs.
- `docs/audits/evidence/navigation-board.png`: desktop 1440 × 1000, authenticated seeded QA loads, Board view after filtering and loading.
- `docs/audits/evidence/navigation-carriers.png`: desktop 1440 × 1000, actual current carrier memberships.
- `docs/audits/evidence/navigation-mobile.png`: mobile 390 × 844 with drawer closed.
- `docs/audits/evidence/navigation-drawer.png`: mobile 390 × 844 with native navigation drawer open.
- Browser captures use deviceScaleFactor 1 and the production server. The reference and implementation were reviewed together in conversation context; no literal contact sheet or automated pixel-difference score is claimed. Unknown source density and different task content prevent pixel-level fidelity claims.

## Comparison and fixes

- The initial shell retained Next's developer badge at the bottom of the rail, obstructing Sign out during development (P2). Developer indicators were disabled; production captures also exclude the badge. The real logout flow passes.
- Earlier low-emphasis navigation and membership metadata was darkened (P2). Final captures were re-inspected for readability; no accessibility certification is implied.
- Carrier scope was initially visible only in the hidden mobile sidebar and Filter count (P2). The active carrier now appears as a removable chip in the work pane.
- Shared controls and login retained a separate palette from the shell (P2). Palette, typography, mint actions and focus/error/success styles now come from global tokens; the shell no longer declares a separate palette. Latest screenshots cover login, create and manual check-ins across desktop/mobile.
- Dashboard readability was increased globally: ink `#18251f`, muted `#46554d` and subtle `#516158` measure 15.87:1, 7.87:1 and 6.56:1 against white. These tokens apply to login, the workspace, forms, onboarding and the shared demo. Accent, error, success and focus styles retain their existing semantics. Selected token checks are not a full WCAG certification.
- Onboarding exposes three required company fields, one agreement review and team invitations in separate steps. Optional fields are disclosed on demand. Drivers see assigned-load cards without management navigation or board/list switching. Mobile join and driver views have no document-wide horizontal overflow at 390 × 844.
- No actionable P0/P1/P2 visual issues remain in the reviewed adaptation. P3: validate larger text and touch ergonomics with dispatchers on physical devices.

## Required visual surfaces

- **Typography:** restrained system sans-serif, compact labels, distinct main title and clear carrier names. Source font identification was unavailable. Long names truncate in the sidebar but remain readable in the directory/inspector. Card accessible names include carrier identity.
- **Layout and spacing:** desktop shell separates an icon rail, contextual sidebar and main pane. The main search field is rounded and controls are sparse. The sidebar can collapse. On phones, the rail remains while the sidebar becomes a native modal drawer. The board scrolls inside its container without document-wide overflow. Toolbar, sidebar labels, directory rows and card regions were inspected at readable scale in the saved captures.
- **Colors and tokens:** global white surfaces, neutral borders and text, mint actions and selected states across authenticated and unauthenticated screens. Shipment colors and stale warning remain supplemental to text labels. This light palette follows the second reference; it supersedes the previous warm amber accent. The standalone original prototype is preserved independently.
- **Asset quality:** real controls and editable text form the UI. Phosphor icons provide rail, sidebar and carrier iconography. No rasterized application or recreated browser chrome is used.
- **Content:** navigation labels describe supported load and carrier workflows. The directory reports session membership rather than claiming legal dispatch authority. Fictional QA identity is visible; no tracking observations are presented as live.

## Browser behavior and limits

Tested: stage and carrier filtering, repeated selections, sidebar collapse/restore, directory search/empty/clear/View loads, mobile drawer selection/closure, keyboard search, Board/List, create/assign/milestone/logout, dialog exclusivity, expired-session recovery, delayed/stale request recovery, gateway errors and idempotent retry. Final captures include JavaScript page-error and unexpected HTTP-resource checks. Local Playwright and installed Chromium provide browser-rendered evidence; no cloud browser connector is available.

Latest production captures show no JavaScript page errors, unexpected failed HTTP resources, document-wide horizontal overflow or mobile inspector overflow. Check-in coverage also verifies assigned-driver mobile entry, stale observations/provenance, saved-but-refresh-failed acknowledgment, version conflict recovery, and retry identity after an uncertain response and detail refresh. Create and load inspectors scroll vertically; captures intentionally choose the relevant content position. No physical-device or Safari verification is claimed.

Earlier design history and before/after screenshots remain in `docs/audits/2026-10-20-application-audit.md` and `docs/audits/2026-10-20-follow-up-audit.md`. Operational check-in findings are in `docs/audits/2026-10-21-operational-audit.md`; the latest onboarding and demo findings are in `docs/audits/2026-10-21-onboarding-demo.md`.
