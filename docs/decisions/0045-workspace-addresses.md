# 0045 Addresses for every page, load, invoice and carrier

Status: accepted

## Decision

The signed-in workspace has real addresses (`src/lib/routes.ts`):

| Address                                                                                                                          | Shows                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `/`                                                                                                                              | Loads (`/loads` is an alias)                            |
| `/loads/:id`                                                                                                                     | a load's record over the list                           |
| `/carriers`, `/carriers/:id`, `/carriers/:id/documents`                                                                          | the directory, a carrier's setup, a carrier's documents |
| `/billing`, `/billing/invoices/:id`                                                                                              | Billing, one dispatch invoice                           |
| `/exceptions` `/inbox` `/contacts` `/prospects` `/assistant` `/documents` `/reports` `/account` `/organization` `/notifications` | the page of that name                                   |

One optional catch-all page (`src/app/[[...path]]/page.tsx`) replaces the old root page and renders the same workspace component; an address that parses to nothing calls `notFound()`. Static pages (`/pricing`, `/demo`, …) and `/api` are matched first. The workspace pushes one history entry per change of page or open record, follows Back, Forward and reload, and sets the document title. The public demo keeps no URL sync.

**A path only says what to show; the server still decides what you may see.** A link to a load, invoice or carrier that does not exist and one that is not yours produce the same message ("We couldn't find that, or it isn't available to your account") and the same API response (404 `NOT_FOUND`). A page your role may not open falls back to Loads with the same message. The rule for which pages a role is offered lives in one function, `sectionAllowed`, used by the sidebar, the command menu and links. A signed-out visitor sees sign-in and lands on the linked record afterwards.

Invoices belong to a carrier and Billing shows one carrier at a time, so `GET /api/dispatch-invoices/:id` answers with the owning carrier (only to people who can see that carrier) and `GET /api/billing` accepts `invoice_id` to include that invoice even when it is older than the newest hundred.

## Consequences

No schema change. Rollback is restoring `src/app/page.tsx` and removing the catch-all.

Found while building: switching carriers quickly in Billing let a slow earlier response overwrite a later one; only the newest request now fills the page. Old `/?view=carriers` links still work and are rewritten to `/carriers`. The ESLint rule `no-html-link-for-pages` is off because it reads Pages Router layouts and flags every plain link once a catch-all exists.

Not done: filters, sort and the open record tab are not in the address; Next.js returns 500 for a malformed `%` escape in any path (framework behaviour, also on `/pricing/%E0`), which is left alone.
