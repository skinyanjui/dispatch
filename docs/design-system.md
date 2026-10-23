# Relay design system

The authoritative guide to how Relay's interface is built. It describes what is implemented; if code and this page disagree, fix whichever is wrong in the same change. Decisions behind it are in ADRs 0033, 0039, 0041, 0044, 0050, 0051 and 0052.

`npm run lint` runs `scripts/check-design-system.mjs`, which enforces the "never" rules below.

## 1. Principles

1. **One canonical implementation per pattern.** Before writing markup, look in `src/components/ui`. Two components that do the same job are a defect.
2. **Data-driven.** Components render from typed props, column definitions and application data. Nothing about a record's content is drawn by hand.
3. **State the label once.** A column's name is in the header, not in every row (section 5).
4. **Tokens, not values.** Colours, spacing, sizes and radii come from `src/app/tokens.css`.
5. **Colour never carries meaning alone.** Status is words plus a tone; every pressed or selected state is announced with ARIA.
6. **Selection never moves anything.** Choosing a tab, chip or option changes colour, underline or background, never weight, size or position of its neighbours.
7. **No hand-built graphics.** No inline `<svg>`. Icons come from `@phosphor-icons/react`; shapes, bars and arrows are HTML and CSS (a native `meter`, borders, gradients).

## 2. File organisation and naming

| Where                  | What                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/ui/`   | Global, domain-free components. Own their markup, classes and ARIA.                                                                                    |
| `src/components/*.tsx` | Domain components (a page, a panel, a card). Compose `ui/` components with data.                                                                       |
| `src/lib/format.ts`    | Formatting of values for display. The only place dates, numbers and percentages are formatted (money is `formatMoney` in `lib/entry.ts`, re-exported). |
| `src/lib/*.ts`         | Business logic, contracts, data access. Never imports from `components/`.                                                                              |
| `src/app/tokens.css`   | Every design token. Loaded first.                                                                                                                      |
| `src/app/ui.css`       | Styles for `components/ui`. Loaded last.                                                                                                               |
| `src/app/board.css`    | The kanban board (`components/board.tsx`).                                                                                                             |
| `src/app/<page>.css`   | Page-specific layout only (not colours, not shared patterns).                                                                                          |

Naming: components are `PascalCase` and named for what they are (`DataTable`, `StatusBadge`); files are `kebab-case`. Props describe intent (`tone`, `pressed`, `actionLabel`), not appearance. Classes are `camelCase`, named for the thing (`dataTable`, `statAction`), not the look.

**When to create, extend or reuse a component**

- **Reuse** if a `ui/` component fits, even if you must pass different data.
- **Extend** (a prop, a variant) if two or more pages need the same thing with a small difference. Prefer a prop over a new component.
- **Create** only for a pattern that appears (or will appear) in at least two places and adds behaviour or accessibility, not for a single wrapped element. A page-specific piece that is not reused stays in its page file.
- Business logic (fetching, permissions, calculations) stays in the page or in `lib/`; `ui/` components only receive props.

## 3. Tokens (`src/app/tokens.css`)

Three layers, all in that one file:

- `:root`: the global palette, type, spacing scale and control scale, used by public pages, sign-in and the app.
- `.appShell`: the signed-in app's neutral palette. It overrides the global palette inside the app.
- `.login`, `.mk`: aliases, public-page colours and the sign-in hero illustration (`--login-glow-*`, `--login-hills-*`, `--login-water-*`).

| Group             | Tokens                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text and surfaces | `--ink`, `--muted`, `--subtle`, `--canvas`, `--panel`, `--soft`, `--panel-soft`, `--border`, `--border-strong`                                                               |
| Action            | `--accent`, `--action`, `--action-hover`, `--action-ink`, `--focus`, `--accent-soft`, `--accent-tint`                                                                        |
| Status            | `--error*`, `--success*`, `--warn*` (each with `-bg` and `-border` where used), `--star`                                                                                     |
| Stages            | `--stage-all`, `-booked`, `-dispatched`, `-transit`, `-delivered`, `-cancelled`, `-contacted`                                                                                |
| Spacing           | `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-7` 32, `-8` 40                                                                                                  |
| Page layout       | `--page-gap` 12px between blocks, `--page-section-step` 12px extra above a section heading, `--page-max` 1100px page width (ADR 0053)                                        |
| Controls          | `--control-h` 32px (fields, buttons, tabs, search), `--control-h-sm` 28px (toolbars, chips, in-table controls), `--control-min` 24px (smallest target), `--control-pad` 10px |
| Radii and shadow  | `--radius`, `--control-radius`, `--field-radius`, `--shadow-menu`, `--shadow-sheet`                                                                                          |
| Loading           | `--skeleton-from`, `--skeleton-to`                                                                                                                                           |
| Inverse and tints | `--ink-inverse`, `--faint`, `--surface-cool`, `--accent-tint-soft`, `--action-disabled`, `--link-on-dark`, `--backdrop`                                                      |
| Time and trend    | `--late`, `--trend-up`, `--trend-down`, `--soon-border`, `--soon-ink`, `--soon-ink-on-dark`, `--caution-ink`                                                                 |
| Stage badges      | `--stage-dispatched-bg`/`-ink`, `--stage-transit-bg`/`-ink`, `--stage-delivered-bg`/`-ink`                                                                                   |
| Avatars           | `--avatar-bg`, `--avatar-carrier-bg`/`-ink`, `--avatar-driver-bg`/`-ink`, `--avatar-external-bg`/`-ink`, `--avatar-record-bg`                                                |
| More shadows      | `--shadow-raised`, `--shadow-card-hover`, `--shadow-inspector`                                                                                                               |

Spacing rule: `padding`, `margin` and `gap` use `--space-1` to `--space-8`. A literal `px` value is allowed only as a 1–2px hairline or optical nudge, and a literal that equals a token fails lint. Off-scale literals that predate the rule are counted per file in `scripts/spacing-baseline.json`; the count can only go down, so lint also fails when a file has fewer than its baseline until you lower the number.

Rules: add a token before using a new colour. `check-design-system.mjs` fails any `#hex` colour in a stylesheet other than `tokens.css`, and any `var(--x)` whose token is not defined. Check the scope too: a token defined only in `.appShell`, `.login` or `.mk` is undefined outside it.

**Typography.** Signed-in text is 13px (tables 13px, notes 12.5px, captions 11–12px). Weights are 400 and 500 for text and 600 for figures and headings, and the weight of an item never changes with its state. Public pages use their own larger scale (ADR 0041).

**Breakpoints.** 1100px (tablet: boards scroll sideways), 1000px (the sidebar becomes a sheet), 800px (two columns collapse to one), 760px (phone layout), 640px (low-priority table columns drop out, tiles go two across), 560px (a board lane is most of the screen).

**Contrast.** Text on its surface meets WCAG 2.2 AA (4.5:1). White on `--action` is 6.5:1; `--warn` on `--warn-bg` is above 6:1. Focus is a 2px outline in `--focus`.

## 4. Components (`src/components/ui`)

| Component                         | Use it for                                                                     | Key props                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DataTable<T>`                    | Every list of records                                                          | `columns`, `data`, `getRowId`, `caption`, `empty`; optional `sort`/`onSortChange`/`defaultSort`, `groups`, `pageSize`+`pageKey`, `onRowOpen`, `loading`, `error`+`onRetry`, `footer`, `rowClassName` |
| `StatTiles`, `StatTile`           | Summary figures; a tile can filter (`pressed`) or open records (`actionLabel`) | `label`, `value`, `hint`, `tone`, `onSelect`                                                                                                                                                         |
| `Tabs`, `TabPanel`                | Switch the panel below                                                         | `items`, `value`, `onChange`, `idPrefix`                                                                                                                                                             |
| `ToggleGroup`                     | Filters (`chips`), option pickers (`segmented`), the Inbox rail (`folders`)    | `items`, `value`, `onChange`, `variant`, `allowNone`, `hideEmpty`                                                                                                                                    |
| `StatusBadge`                     | A short status                                                                 | `tone`: neutral, good, warn, bad                                                                                                                                                                     |
| `BarList`                         | Values compared as bars                                                        | `bars` (label, value, display, description)                                                                                                                                                          |
| `ErrorAlert`                      | A failure, with optional Retry                                                 | `error` or children, `onRetry`, `polite`                                                                                                                                                             |
| `EmptyState`                      | Nothing to show                                                                | `icon`, `title`, `description`, `action`, `variant` page or inline                                                                                                                                   |
| `PageIntro`                       | The note and actions under the sidebar                                         | `title` (read out), `children`, `actions`, `showTitle`                                                                                                                                               |
| `Breadcrumb`, `ListItem(s)`       | Trails and rows                                                                | see the files                                                                                                                                                                                        |
| `components/board.tsx` `Board<T>` | Kanban boards (Loads, Prospects)                                               | `lanes`, `renderCard`, `onMove`, `canDrag`                                                                                                                                                           |

**Variants and states.** Every interactive component supports: default, hover, focus (visible ring), pressed or selected (`aria-pressed`, `aria-selected`, `aria-current`), disabled (`disabled`, never just greyed), and busy. Components that load data support: loading (skeleton or `aria-busy`), empty (`EmptyState`), error (`ErrorAlert`, with Retry where a retry is possible), success (an `inlineNotice` with `role="status"`), and permission-denied (the server answers 404 for anything the person may not see, so the page shows the same empty or not-found state as for a missing record; it never shows a forbidden record's existence).

**Composition.** Page = `PageIntro` → summary `StatTiles` → filters (`ToggleGroup`) → `Tabs`/`TabPanel` → `DataTable` or `Board`. A page's own action goes in `PageIntro` `actions`, or at the top of its tab panel (`.panelToolbar`) when it belongs to one tab, so switching tabs never moves the strip.

## 5. Data tables

All tabular data is a `DataTable` with a typed column definition. **Column names are defined once and shown once**, in the header.

```tsx
type ColumnDefinition<T> = {
  id: string;
  header: string;
  accessor: keyof T | ((row: T) => unknown);
  type?: "text" | "number" | "money" | "date" | "datetime" | "status";
  align?: "left" | "center" | "right"; // numbers and money default to right
  width?: "xs" | "sm" | "md" | "lg" | "xl"; // a design-system width, not a raw size
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  descendingFirst?: boolean;
  priority?: "high" | "low"; // "low" columns are hidden under 640px
  rowHeader?: boolean; // the cell that names the row; default the first
  render?: (value: unknown, row: T) => ReactNode;
};

<DataTable
  caption="Dispatch invoices"
  columns={invoiceColumns}
  data={invoices}
  getRowId={(i) => i.id}
  defaultSort={{ column: "number", descending: true }}
  pageSize={25}
  pageKey={filter}
  onRowOpen={(i) => open(i.id)}
  empty={{ title: "No invoices yet", description: "…" }}
/>;
```

- The same column definition draws the header, every cell, the sort and the alignment. `type` sets the formatting (`formatMoney`, `formatDate`, `formatDateTime`, `formatNumber`) and default alignment; use `render` for anything richer (a badge, a button, an icon).
- Semantics: one `table` with a `caption`, `th scope="col"` headers, `th scope="row"` for the row's name, `aria-sort` on sortable headers, and a focusable scroll region. Sortable headers are buttons.
- **Responsive: scroll, don't restack.** On narrow screens the table scrolls sideways with the row's name held in place, and `priority: "low"` columns are hidden under 640px. A row is never turned into a card of repeated "Label: value" pairs.
- Built in: loading (`loading`), empty (`empty`), error (`error` + `onRetry`), paging (`pageSize`, "Show more"; `pageKey` restarts paging when a filter changes), groups (`groups`), row opening (`onRowOpen`), and extra footer rows (`footer`).
- A row that is not tabular (a card on a kanban board, a message in a thread) is not a `DataTable`. The `Board` and card layouts name a value with an icon or position; a label appears only where the value would be ambiguous without it.

## 6. Forms, navigation, lists and dashboards

- **Forms.** One field per label, label above, errors in `ErrorAlert` or beside the field with `role="alert"`; required fields use native `required`; a field's help text sits below it and never moves its neighbour. Controls share `--control-h`. Dropdowns draw one CSS arrow.
- **Navigation.** One sidebar: each page listed once; a page's own views (Inbox folders, Loads carriers) nest under it while it is open, with a toggle. Settings live in the account menu. Tabs are for views of one page; chips and segments are filters and pickers.
- **Cards and lists.** Use `ListItem(s)` for passive rows, `Board` cards for work in progress, and `DataTable` for records you compare.
- **Dashboards.** `StatTiles` for figures, `BarList` for a comparison, `DataTable` for detail. No charts drawn from SVG; if a chart is needed, add a `ui/` component built from HTML and CSS and record it in an ADR.

## 7. Formatting

Format at the edge, in one place: `lib/format.ts` (dates, numbers, percentages) and `formatMoney` (money, integer minor units, no floating point). Pages never call `toLocaleString` themselves.

## 8. What is not allowed

Enforced by `scripts/check-design-system.mjs`:

- Inline `<svg>` anywhere in `src/**/*.tsx`.
- Inline `style={…}` (one exception: `global-error.tsx`, which renders when the app's stylesheets may not have loaded).
- A raw `<table>` outside `DataTable`.
- `data-label` / `attr(data-label)` (per-row field names).
- A hand-built `role="tablist"`, `className="alert error"`, `directoryEmpty` or `directoryIntro`.
- Raw `#hex` colours outside `tokens.css`, and `var(--x)` for an undefined token.

Enforced by lint: unused imports and variables.

Allowed exception: `public/favicon.svg`, a static logo asset.

## 9. Testing

- `tests/browser/controls.spec.ts`: clicking any tab, chip, segment, folder or queue pill moves nothing.
- Table pages assert headers (`columnheader`), no `[data-label]` cells, sorting by header, and no sideways page overflow at 390px.
- `tests/browser/*-responsive.spec.ts` check each page at desktop and phone widths; the accessibility scans (axe, WCAG 2.2 AA) run on the main pages.
