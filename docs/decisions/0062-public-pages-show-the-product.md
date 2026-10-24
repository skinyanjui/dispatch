# 0062 Public pages show the product instead of describing it

Status: accepted, 2026-10-24.

## Context

The home, How it works, Get started and Pricing pages explained the product in paragraphs and lists. A visitor had to take the words on trust, and the words repeated what the product already shows.

## Decision

- **Working interactions** (`src/components/mini-demos.tsx`) built from the real components (`LoadCard`, `LoadCheckIns`) and the interactive demo's own adapter, created per interaction with `persist: false` so it is private, in memory and never the demo's saved state: assign a driver (another carrier's driver is refused with the real message; dispatching before assigning says to assign first), record a check-in (its source and observed time stay visible), bill separately (packet and invoice move independently; amounts in whole cents), a draft filled from a template (what is missing is flagged, never guessed; review is a person's act), and an AI switch (off until turned on).
- **Pictures of states** (`src/components/step-visuals.tsx`) for steps that are not interactive, drawn with the app's pills and real wording (including the real "needs a current, verified dispatch agreement" refusal).
- **Pages:** the home page's three cards and its assistant list became the interactions; How it works and Get started became a step list with one short sentence and one interaction or picture per step; Pricing's assurance became the AI switch. The guardrails list was dropped because the interactions demonstrate it.
- **One note per page**, not per interaction: "The interactions and pictures use fictional sample data in your browser. Nothing is sent." The home preview keeps its own note.
- `tests/browser/mini-demos.spec.ts` drives each interaction (including from the keyboard), checks the real messages, the whole-cent amounts, that the demo's saved state is untouched, one-sentence step text, and accessibility on all four pages. `mobile-audit.spec.ts` still passes at 320 and 390px.

## Consequences

The public pages ship more client code (the real components in a marketing page). Because the interactions use the app's components, they change when the app does; their tests fail loudly if the demo rules or messages change. Rollback: restore the previous page files; the components are independent.
