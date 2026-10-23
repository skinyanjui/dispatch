# 0059 API family audiences

Status: accepted, 2026-10-23.

## Context

Authorization lived inside each handler. Some handlers parse and validate the request body before checking the person's role, so someone outside a role could learn field names from validation errors (backend audit, 2026-10-23), and a new endpoint had no prompt to decide who may call it.

## Decision

`src/lib/policy.ts` declares an audience for every top-level API family (`public`, `any`, `self`, `non-driver`, `staff`). After the session and required-MFA checks, and before any handler runs or any body is read, the router calls `enforceAudience`. Outsiders of `staff` families (document templates, drafts, assistant, prospects) and `non-driver` families (reports) get `404 NOT_FOUND`, the same answer those handlers already gave for reads, and the refusal is audited like any other 404. Handlers keep their record-level and carrier-level checks; the gate is additive and never grants access.

`tests/integration/policy.test.ts` fails when the router serves a family that is not declared (or the table lists one it no longer serves), so a new family requires an explicit decision in review. It also checks that outsiders get 404 without a validation error and that staff still reach their handlers.

## Consequences

One extra membership query on gated families. Families marked `any` still rely on their handlers; narrowing them is a later step (each needs its audience verified against the UI and tests first). Rollback: remove the `enforceAudience` call in the router.
