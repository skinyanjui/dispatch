# 0033 — Blue design tokens

Status: accepted, 2026-10-22. Supersedes the mint action colour chosen in ADR 0027.

## Decision

The whole application, not only the sign-in screens, uses one blue palette defined once in `:root` in `src/app/globals.css`. Sign-in styles (`src/app/login.css`) read the same tokens.

| Token | Value |
| --- | --- |
| `--accent`, `--action`, `--focus` | `#2f4cf5` (primary actions, links, active states, focus ring) |
| `--action-hover` | `#2440d8` |
| `--action-ink` | `#fff` (white on blue is 6.5:1) |
| `--accent-soft`, `--accent-soft-hover` | `#e8edff`, `#d6defd` |
| `--ink`, `--muted`, `--subtle` | `#0f1b3d`, `#4a5578`, `#5f6a8d` |
| `--border`, `--border-strong` | `#e3e7f3`, `#c3cae0` |
| `--soft`, `--sidebar-bg`, `--sidebar-hover`, `--sidebar-active` | `#f6f8fd`, `#f6f8fd`, `#eceffa`, `#e1e7fb` |

**Colour keeps its meaning.** Blue is brand and interaction only. Red (`--error*`), amber (due soon, overdue, warnings) and green (`--success*`, Paid, Accepted, Delivered, the delivered stage dot) are semantic and unchanged: green still means "good". Neutral greys that were tinted green were moved to blue-greys with the same lightness.

**Not changed:** `public/legacy-demo.html` (the historical reference), stage dot colours, layout, spacing and behaviour. Accessibility is checked by the axe guard tests over every main page on desktop and phone.
