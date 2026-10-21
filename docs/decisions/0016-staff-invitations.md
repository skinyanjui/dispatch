# 0016 — Dispatcher and organization-admin invitations

Status: accepted, 2026-10-21. Extends ADR 0011 (organization admins) and ADR 0006 (carrier invitations).

## Decision

Dispatchers and administrators are invited by an organization's owners and administrators, instead of being created by an operator. Staff invitations are **organization-scoped**, so they live in their own `staff_invites` table rather than overloading the carrier-bound `onboarding_invites`. The `/join#token` page and the inspect/accept endpoints are shared: the server looks the token up in either table.

- **Who may invite:** owners and administrators invite dispatchers; only **owners** invite administrators and remove them. This prevents privilege escalation through the invitation path. Carrier managers and dispatchers cannot invite staff. Foreign organizations get 404.
- **What an invitation grants:** a *dispatcher* invitation names one or more carriers of the organization and creates dispatcher memberships on exactly those, so a new dispatcher sees only those carriers' loads. An *administrator* invitation creates an `organization_members` admin row and may optionally add dispatcher memberships. Carriers are verified against the organization when the invitation is created and again when it is accepted.
- **Link handling:** same as other invitations. A browser-generated 32-byte secret is held across uncertain retries, only its SHA-256 is stored, and the secret travels in the URL fragment and POST bodies. Links are single-use and expire after 7 days. A new invitation for the same address revokes earlier pending ones. The link is also queued as an encrypted email through the notification outbox (ADR 0010), and can be copied as a fallback.
- **Acceptance:** a new person sets a password. An existing account must be signed in as the invited address, and an existing membership with a different role on a carrier (for example a driver) is refused with `MEMBERSHIP_CONFLICT` rather than silently changed. Accepting also verifies the email address.
- **Audit:** `organization_events` (append-only) and `audit_logs` record creation, revocation, acceptance and administrator removal. It does not feed the outbox, which has no consumer for organization events.
- **Removal:** owners remove administrators (`POST /api/organizations/:id/admins/remove`); owners cannot remove themselves or other owners here. Removing an administrator does not change their carrier memberships, which are handled by team removal (ADR 0011).
- **Phone:** `users.phone` is added so teammates can be reached (contacts, ADR 0017); it can be set on joining and in Account.

## Not included

Changing an existing person's role, transferring ownership, and listing accepted or revoked invitation history.

## Rollback

Keep migration 014 (additive). Pending staff invitations simply stop working under older code.
