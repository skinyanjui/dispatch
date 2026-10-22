# 0050 Narrower navigation, a control-sized marketing top bar, and the Assistant chat page

Status: accepted

## Decision

- **Widths.** The application sidebar is 216px (was 248px; it still sizes to its longest label up to that, minimum 148px). The Inbox rail is 124px (was 140px) and 116px between 801 and 1100px.
- **Marketing top bar.** Brand, links and actions sit on one centre line in a three-column grid (brand left, links centred, actions right). Links and both actions use the app's 32px control height, 7px control radius and 13.5px type (ADR 0044). On phones the links take a second row, left-aligned.
- **Assistant page.** A fixed-height chat panel: a history list beside the thread from 900px up, a select below that; the thread is the only part that scrolls and the composer stays at the bottom. Empty state shows example prompts in a wrapping row that fills its width. Questions are right-aligned bubbles, answers are plain text with an avatar, sources are chips, the composer grows with its text and sends with an icon button named "Ask". Accessible names are unchanged (log "Conversation", form "Ask the assistant", field "Your question"), so the same keyboard and screen-reader paths work. No API, schema or permission change; consent, cost limits and the read-only rule of ADR 0031 are untouched.

## Consequences

CSS and one component. Rollback is reverting the commit. Browser tests that clicked an example prompt by name now scope to the conversation log, because a past conversation in the history list can carry the same title.
