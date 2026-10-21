# Reports and Inbox: click-path audit

Server behaviour is unchanged; this audit covers the front end. "Before" is the
code at the start of this change, "After" is this change. Each flow lists the
test that covers it.

| Flow                                         | Before                                            | After                                                         | Test                               |
| -------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| See which range is active                    | Not shown (plain text buttons)                    | Pressed state on the range control                            | workspace: reports pressed range   |
| Open the exceptions behind "Open exceptions" | Dead number; Account menu or sidebar, 2 clicks    | 1 click on the card                                           | workspace: reports KPIs            |
| Open loads missing a POD                     | Loads, then find the Paperwork chip, 3 clicks     | 1 click on the card                                           | workspace: reports KPIs            |
| Open a carrier's loads from its row          | Not possible; Loads then carrier filter, 3 clicks | 1 click on the carrier name                                   | workspace: reports KPIs            |
| Open loads by pipeline stage                 | Not possible                                      | 1 click on a stage                                            | workspace: reports KPIs            |
| Compare with the last period                 | Not possible                                      | Shown on four cards; omitted if its request fails             | covered by render in the same test |
| Sort the by-carrier table                    | Fixed order                                       | Click a header; `aria-sort` announced                         | workspace: reports KPIs            |
| Filter inbox by channel                      | Tabs spanned both panes, above the list           | Tabs are the top of the conversation column                   | workspace: inbox tabs              |
| Choose how to send                           | One "Action" select mixing 9 modes                | Relay / Email / Text buttons, separate "Log activity" menu    | operations: inbox tests            |
| Add a recipient                              | Click "Add Name" links (6 shown at once)          | Type, Enter adds the first match, arrows move through matches | workspace: inbox tabs              |
| Edit saved replies                           | Panel pushed the list down, no focus return       | Dialog; Esc closes, focus returns to the button               | operations: saved replies          |
| Click through conversations quickly          | Slow response could replace the newer one         | Latest click always wins                                      | by construction (request guard)    |
| Back to the list                             | Button shown on desktop too                       | Phones only                                                   | workspace: inbox tabs              |

## Added later: unread, archive, trash and Carriers

| Flow                                                   | Before                    | After                                              | Test                                  |
| ------------------------------------------------------ | ------------------------- | -------------------------------------------------- | ------------------------------------- |
| Mark a conversation unread                             | Not possible              | One click in the thread header, or `u` in the list | workspace: inbox unread/archive/trash |
| Archive or trash                                       | Not possible              | One click or `e` / `#`, with Undo for 8 seconds    | same                                  |
| See unread per channel                                 | Not shown                 | Count on each rail item                            | integration: inbox-states             |
| Get an archived conversation back when someone replies | n/a                       | Automatic, no write                                | integration: inbox-states             |
| See which carriers need attention                      | Open each carrier's setup | Summary filters and badges on one page             | workspace: carriers                   |
| Open a carrier's loads, exceptions or agreement        | 2 to 3 clicks             | 1 click on the number or badge                     | workspace: carriers                   |

Permanent delete is intentionally not offered (ADR 0035).

## Billing

| Flow                                   | Before                                                    | After                                              | Test                  |
| -------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- | --------------------- |
| See overdue invoices                   | Summary number was inert; Invoices tab, then Overdue chip | 1 click on the Overdue card                        | workspace: billing    |
| See what is outstanding or collected   | Same                                                      | 1 click on the card (filters Open or Paid)         | workspace: billing    |
| Start billing delivered loads          | Tab, then New invoice                                     | 1 click on "Ready to invoice"                      | workspace: billing    |
| Find the largest or latest-due invoice | Fixed order                                               | Sort Invoice, Due, Total or Balance; `aria-sort`   | workspace: billing    |
| Open an invoice                        | Click the number only                                     | Click anywhere on the row                          | workspace: billing    |
| Know how late                          | Date only                                                 | "N days overdue" or "Due in N days" under the date | rendered in the table |
| Work through 100 invoices              | All rendered at once                                      | 25 at a time with Show more                        | workspace: billing    |
| Find loads that need a packet          | Scan the table                                            | Needs packet / Submitted / Paid filters            | workspace: billing    |
