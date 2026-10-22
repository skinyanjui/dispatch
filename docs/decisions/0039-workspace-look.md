# 0039 — Workspace look

## Decision

The signed-in app adopts a quiet "grey frame, white panel" look taken from reference screenshots supplied by the product owner: a light grey canvas with a transparent sidebar, one white content panel with a hairline border and rounded corners, compact 13px type, flat outlined buttons with blue kept for the main action, text-style toolbar actions, hairline table grids with muted headers, and flat cards. It is implemented in `src/app/workspace-look.css`, scoped to `.appShell`, so sign-in, onboarding and the public pages keep their own style. The colors and sizes were chosen by eye from the screenshots; no third-party CSS or assets were used (see ADR 0036 on licensing).

Text colors were darkened from the screenshots' lighter greys (`--muted #666`, `--subtle #6b6b6b`) so every combination passes WCAG AA contrast, which the axe tests enforce.

## Not yet done

A record page (fields panel plus Timeline / Tasks / Notes / Files tabs) for loads, and an "Add New" row and "Calculate" footer on tables.
