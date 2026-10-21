# Carrier and driver onboarding

All actions use the existing authenticated workspace and carrier permissions. The initial dispatcher still comes from controlled QA setup; onboarding does not create a global administrator or a new dispatch organization.

## Add a carrier

1. Sign in as a dispatcher and open **Carriers → Add carrier**.
2. Enter company name, contact name and contact email. Phone and USDOT are optional. Choose a workspace only if you dispatch for more than one organization.
3. Select **Save and continue**. The carrier is saved and can be resumed through **Manage setup**. Closing before this first save leaves an unsaved form; later saved steps remain on the server.
4. Review the signed dispatch agreement held in your own records. Enter its reference and validity dates, then confirm the review. This records the dispatcher's attestation; it does not upload or automatically verify a document.
5. Create a carrier invitation for the contact, add drivers, or finish and return later. An inactive/future/expired agreement keeps booking and setup completion unavailable until a current agreement is recorded.

## Invite a driver

As a dispatcher or carrier manager, open the carrier's **Manage setup → Add driver**. Enter the driver's name and email and create an invitation. Copy the private one-use link and deliver it directly to its recipient. **No email or SMS is sent automatically.** Links expire after7 days. **New invite link** replaces the previous unused link for that driver.

The driver stays **Waiting to join** and cannot be assigned until they accept. The join screen prefills their identity, asks for one password (with a Show control), and puts optional contact details behind disclosure. Existing Relay users enter their current password instead; invitations never change it. Once joined, drivers see **My loads**, simple route cards and check-ins for assigned work. Booking, assignment and carrier management remain restricted.

## Access and recovery

- New carriers inherit only the creating dispatcher's access. Invite the carrier manager separately.
- Contact edits do not remove an existing member's access; membership administration/removal is not implemented. Contact email changes revoke unused prior manager invitations.
- Lost create/invite responses retry with the same request key and token, avoiding duplicate records or broken links. Saved-step reload is available after errors; stale profile edits conflict instead of overwriting newer changes.
- A used/expired invitation cannot be accepted again. If already joined, use normal sign-in; otherwise request a new invitation from the carrier contact/dispatcher.
- If an invitation conflicts with an existing different role for that carrier, ask the dispatcher to review access; no silent role conversion occurs.
- Links confer access to the named identity through out-of-band sharing. Keep them private. No email-verification service or tracking consent is represented as completed.

## Server contracts

| Endpoint | Scope / behavior |
| --- | --- |
| `POST /api/onboarding/carriers` | Dispatcher in an accessible organization; company details + organization_id + UUID key. |
| `GET /api/onboarding/carriers/:id` | Own dispatcher/manager scope; saved profile, agreement and drivers. |
| `POST /api/onboarding/carriers/:id/company` | Own dispatcher/manager; version + company fields + UUID key. |
| `POST /api/onboarding/carriers/:id/agreement` | Dispatcher only; reference, effective_date, through_date, confirmed=true, UUID key. |
| `POST /api/onboarding/carriers/:id/complete` | Current agreement required; idempotent completion. |
| `POST /api/onboarding/carriers/:id/manager-invite` | Dispatcher only; UUID key and random64-hex token. |
| `POST /api/onboarding/carriers/:id/drivers` | Own manager/dispatcher; name, email, UUID key and random64-hex token. |
| `POST /api/onboarding/carriers/:id/drivers/:driverId/invite` | Reissue for a pending driver in the same carrier. |
| `POST /api/onboarding/invitations/inspect` | Private token in JSON; minimal recipient preview. |
| `POST /api/onboarding/invitations/accept` | Token + name, optional contact/timezone, new password only for a new account; secure session cookie. |

All writes require the same Origin. Invalid/expired/used invite responses reveal no carrier data without the private token. Role/carrier guesses are rejected. Current queue and manual-check-in contracts continue unchanged. Migration004 adds persisted onboarding; no new deployment variable is required beyond the existing database configuration.

## Current public demo

`/demo` uses the same React screens, controls, darker text and wizard as the authenticated software. `/demo.html` redirects there. Its local adapter provides fictional loads, assignment, milestones, manual check-ins and carrier/driver onboarding. A role selector previews dispatcher, carrier and driver experiences. Changes stay in this browser (or the tab if local storage is unavailable); Reset demo clears only this sandbox. Demo invitation links work in the same browser. Demo passwords are never persisted. No authenticated API, carrier, messaging, finance or tracking service is called.

The independent historical prototype remains at `/legacy-demo.html` and `index.html`. Its exception/document/billing concepts are historical reference material, not implemented server features. The current demo does not advertise those workflows as available. Exception lifecycle, secure uploads and separate financial workflows remain backlog work.
