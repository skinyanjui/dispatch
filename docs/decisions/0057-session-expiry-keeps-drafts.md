# 0057 A session that expires keeps open drafts

Status: accepted, 2026-10-23.

## Context

When a request came back 401, the workspace unmounted and showed the sign-in screen. Anything someone was typing (a new load, a vehicle, a message, an edit) was lost, even when they signed straight back in. The flow and error audit (`docs/audits/2026-10-23-flow-and-error-audit.md`) listed it as open.

## Decision

- Only `AUTH_REQUIRED` and `SESSION_EXPIRED` mean the session ended. Any other 401 (a wrong password or code) is an ordinary error shown where it happened.
- When the session ends in a signed-in workspace, the workspace stays mounted and sign-in appears over it as a native modal dialog (`ExpiredSignIn`). A native dialog stacks above drawers that are already open, makes everything behind it inert, and is not dismissed by Escape.
- Loaded business data does not outlive the session: the shell's loads list is cleared at once, as on a full sign-out, and reloads after sign-in. Open dialogs and drawers keep their drafts; that is the point of the change. (`workspace.spec.ts`, "session recovery", still asserts the board is cleared.)
- The same person signing in returns to the screen as they left it. A different person signing in reloads the page, so they never inherit the previous person's screen, drafts or lists.
- A sign-out, and a 401 before anyone was signed in, are unchanged: the workspace is unmounted and the sign-in screen is shown.

## Consequences

- Data held inside a page's own components (for example the Fleet table) stays in the page behind the inert dialog until the person signs in or reloads. It is not visible or reachable, and the session cookie is gone; it is what was already on the screen. If that is not acceptable for a deployment, a 401 can reload the page instead, at the cost of the drafts.
- Rollback: restore the old `handleError` branch (it is `handleSignedOutError`) and remove `ExpiredSignIn`.
