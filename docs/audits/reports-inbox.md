# Reports and Inbox: click-path audit

Server behaviour is unchanged; this audit covers the front end. "Before" is the
code at the start of this change, "After" is this change. Each flow lists the
test that covers it.

| Flow | Before | After | Test |
| --- | --- | --- | --- |
| See which range is active | Not shown (plain text buttons) | Pressed state on the range control | workspace: reports pressed range |
| Open the exceptions behind "Open exceptions" | Dead number; Account menu or sidebar, 2 clicks | 1 click on the card | workspace: reports KPIs |
| Open loads missing a POD | Loads, then find the Paperwork chip, 3 clicks | 1 click on the card | workspace: reports KPIs |
| Open a carrier's loads from its row | Not possible; Loads then carrier filter, 3 clicks | 1 click on the carrier name | workspace: reports KPIs |
| Open loads by pipeline stage | Not possible | 1 click on a stage | workspace: reports KPIs |
| Compare with the last period | Not possible | Shown on four cards; omitted if its request fails | covered by render in the same test |
| Sort the by-carrier table | Fixed order | Click a header; `aria-sort` announced | workspace: reports KPIs |
| Filter inbox by channel | Tabs spanned both panes, above the list | Tabs are the top of the conversation column | workspace: inbox tabs |
| Choose how to send | One "Action" select mixing 9 modes | Relay / Email / Text buttons, separate "Log activity" menu | operations: inbox tests |
| Add a recipient | Click "Add Name" links (6 shown at once) | Type, Enter adds the first match, arrows move through matches | workspace: inbox tabs |
| Edit saved replies | Panel pushed the list down, no focus return | Dialog; Esc closes, focus returns to the button | operations: saved replies |
| Click through conversations quickly | Slow response could replace the newer one | Latest click always wins | by construction (request guard) |
| Back to the list | Button shown on desktop too | Phones only | workspace: inbox tabs |

Not done, and why: marking a conversation unread and per-tab unread counts need
server support that does not exist; archive and delete are not modelled.
