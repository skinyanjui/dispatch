# 0050 Narrower navigation, a control-sized marketing top bar, and the Assistant chat page

Status: accepted

## Decision

- **Widths.** The application sidebar is 216px (was 248px; it still sizes to its longest label up to that, minimum 148px). The Inbox rail is 124px (was 140px) and 116px between 801 and 1100px.
- **Marketing top bar.** Brand, links and actions sit on one centre line in a three-column grid (brand left, links centred, actions right). Links and both actions use the app's 32px control height, 7px control radius and 13.5px type (ADR 0044). On phones the links take a second row, left-aligned.
- **Assistant page.** A fixed-height chat panel: a history list beside the thread from 900px up, a select below that; the thread is the only part that scrolls and the composer stays at the bottom. Empty state shows example prompts in a wrapping row that fills its width. Questions are right-aligned bubbles, answers are plain text with an avatar, sources are chips, the composer grows with its text and sends with an icon button named "Ask". Accessible names are unchanged (log "Conversation", form "Ask the assistant", field "Your question"), so the same keyboard and screen-reader paths work. No API, schema or permission change; consent, cost limits and the read-only rule of ADR 0031 are untouched.

## Consequences

CSS and one component. Rollback is reverting the commit. Browser tests that clicked an example prompt by name now scope to the conversation log, because a past conversation in the history list can carry the same title.

## Addendum: page views nested in the sidebar

A page's own views now sit under it in the main sidebar while that page is open, in the way Vercel nests a page's sections: the Inbox folders (All, Unread, Relay, Email, Texts, Calls, Archived, Trash, with their counts) and, on Loads, the carrier list. Each group has a "Folder list" or "Carrier list" toggle that announces whether it is expanded. The workspace owns the open Inbox folder, so the sidebar and the page always agree.

On a desktop with the sidebar expanded the Inbox rail is not shown, which gives the conversation list and thread about 124px back; "New message" moved to the top of the list. Where the sidebar cannot show the folders (collapsed to icons, or below 1001px where it becomes a sheet) the rail, or the chip row on phones, is still on the page. Status pills on Loads and the tabs on Billing, Documents, Organization and Account stay on their pages: they are filters or two-to-four views, and settings stay behind the account menu. Presentation only; no API or permission change.
