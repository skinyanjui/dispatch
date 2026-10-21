# 0018 — Inbox, messages and saved replies

Status: accepted, 2026-10-21.

## Decision

An **Inbox** keeps one record of conversations with the people in Contacts (ADR 0017). A conversation (`threads`) has participants, optionally one load, and an ordered list of `messages`. A message is either:

- **Sent by Relay** (`source = relay`): a Relay message, an email or a text. Each recipient gets a `message_deliveries` row with a status the sender can see.
- **Logged by hand** (`source = logged`): a call, or an email or text handled outside Relay, with direction (in/out), who it was with and when. Nothing is sent.

### Why logging instead of inbound email and SMS

Relay does not read anyone's mailbox or phone. Receiving replies would need inbound webhooks (verified signatures, a public endpoint, per-tenant addresses and numbers, threading by headers, spam and abuse handling) and provider accounts, none of which exist yet. Outgoing emails carry the sender's own address as `Reply-To`, so replies reach the person normally; they can then log the reply. The UI says this plainly. Inbound webhooks are a later change and would add messages with `source = inbound` to the same tables.

### Channels

| Channel | How | Failure behaviour |
|---|---|---|
| Relay message | stored; recipient must have an account (staff, or a driver who has joined) | always `delivered` once saved; unread badge |
| Email | existing encrypted outbox (ADR 0010), `kind = message`, one notification per recipient, sender as `Reply-To` | retried with bounded backoff; status mirrors the outbox |
| Text | Twilio-compatible transport, off unless configured | **attempted once.** A timeout may still have reached the phone, so it is recorded as `unknown` and never retried automatically; the UI says not to resend until confirmed |

Texts need the recipient's recorded consent: users opt in on their account, external contacts carry a consent timestamp, the person who recorded it and a note of how they agreed. Without consent, or without a dialable number, the send is refused. Replying STOP at the provider is not yet reflected in Relay.

### Access

A conversation is visible to its creator, its participants, dispatchers of its carrier, and organization admins. Recipients are resolved through the caller's own directory, so a message to someone the caller cannot see is `NOT_FOUND`, exactly like a foreign id. A load-linked conversation needs access to that load. Drivers can message only in Relay, cannot log, and see only conversations they are in. Sending is idempotent per actor (UUID key plus a hash of the request); a changed retry is `IDEMPOTENCY_CONFLICT`.

### Data

- Message bodies are kept with the conversation as the business record (who told whom what). Outbox email bodies are encrypted and purged after delivery as before, so the long-lived copy is the message row.
- A person can be stored under two keys (`user:` and `driver:`). Recipient resolution accepts either and delivers once.
- Read state is per user (`thread_reads`). Unread is computed, not counted.
- Saved replies are personal or shared with the owner's organization; `{name}`, `{load}` and `{sender}` are filled in when inserted, and the user can edit the text before sending.

## Consent and cost

Nothing is sent by default: email needs the existing transport configuration, texts need `RELAY_SMS_TRANSPORT=twilio` with credentials. The demo never sends; it records messages in the browser only and says so on each delivery.

## Not included

Inbound email/SMS, attachments, per-message edit/delete, message retention rules, provider STOP/HELP handling, delivery receipts from Twilio, group chats with typing, and push notifications.

## Rollback

Keep migration 016 (additive). Disable by unsetting the SMS transport; the Inbox page can be hidden without data loss.

## Addendum: resending texts (2026-10-21)

A failed or unconfirmed text can be resent from the thread (`POST /api/message-deliveries/:id/resend`). The caller must name the attempt number they saw (`DELIVERY_CHANGED` otherwise), so a double click or two dispatchers cannot send it twice. An "unknown" outcome additionally needs `confirm_unknown` because the first text may have arrived. Consent and the number are re-checked at resend time, each resend is audited, and a text stuck "queued" for over five minutes is shown as unknown. Resends are still single attempts with no automatic retry.

## Addendum: attachments (2026-10-21)

Messages can carry up to three PDF/PNG/JPEG files of up to 4 MB each. A file is uploaded first (`POST /api/message-attachments`): its type is sniffed from the bytes, it is scanned by the same ClamAV client as documents (infected files are never stored; a missing scanner fails closed when `RELAY_REQUIRE_MALWARE_SCAN` is set), and its bytes go to the same object store as documents (`document_objects`, write-once, S3 or PostgreSQL). It is then linked once, by its uploader, to a message; the link is permanent (migration 020 trigger). Before it is attached only the uploader can open it; afterwards anyone who can see the conversation can, through the same access rule as the thread, with an audit record per download and a 60-second signed URL on S3.

**Attachments stay inside Relay.** They are allowed on Relay messages and hand-logged entries (to keep a file from an outside email). Texts cannot carry files and outgoing email goes through a body-only outbox, so those channels refuse them (`ATTACHMENTS_NOT_SUPPORTED`). Emailing a file to a broker still happens from the user's own mail client. Unattached uploads are capped at 20 per user per day; cleanup of abandoned uploads is not automated yet. The demo does not support attachments.
