# 0023 — Inbound email and text

Status: accepted, 2026-10-21. Supersedes the "manual logging only" limit in ADR 0018 where configured.

## Decision

Replies to messages sent from Relay can arrive automatically through two signed webhooks. Neither is on by default; with no secrets configured both return 503 and everything works as in ADR 0018 (reply to the sender's own address, log by hand).

**Texts — `POST /api/webhooks/sms`.** Twilio's inbound webhook, verified with `X-Twilio-Signature` (HMAC-SHA1 of the public URL plus sorted parameters, keyed by `TWILIO_AUTH_TOKEN`, compared in constant time). The URL is built from `APP_ORIGIN`, so set it behind a proxy. A text is added to the conversation Relay last texted that number in, within 30 days; the sender is shown by the participant's name. A text from a number Relay never texted is **not stored** (we would not know which tenant it belongs to); only a content-free audit record is kept. `MessageSid` is unique per channel, so provider retries add nothing.

**STOP.** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT withdraw text consent for every user and contact with that number at once (before any threading), write an audit record, and the next send is refused (`RECIPIENT_CHANNEL_UNAVAILABLE`). START/re-consent is a deliberate manual action, never inferred.

**Email — `POST /api/webhooks/email`.** A provider-neutral JSON body (`id`, `from`, `to[]`, `subject`, `text`) signed `x-relay-signature: sha256=<HMAC-SHA256 of the raw body>` with `RELAY_INBOUND_SECRET`. Outgoing email gets `Reply-To: reply+<thread>.<mac>@RELAY_INBOUND_EMAIL_DOMAIN`; the mac is an HMAC of the thread id, so addresses cannot be guessed or redirected to another thread. The sender must already be a participant with that email address: `From` is forgeable, so an unknown sender never writes into a conversation (rejected, audited). Quoted history (`>` lines, "On … wrote:") is dropped; the body is capped at 5,000 characters; attachments on inbound mail are ignored.

**Data.** Inbound messages have `source = 'inbound'`, no Relay sender, the sender's label and the provider's message id (migration 021). They notify the conversation's Relay participants like any message and count as unread.

## Not included

Provider-specific adapters (a small forwarder per provider maps its payload onto the JSON above), inbound attachments, MMS, matching an inbound text to a brand-new conversation, HTML-only email, bounce and spam handling, and per-tenant phone numbers (one shared number is used, so a number texted from two tenants threads with the most recent).

## Verification

Tested with signed fixtures in-process (valid, forged, tampered, duplicate, unknown sender, unknown number, STOP). No live Twilio or inbound email provider was reachable; send one real text and one real reply before relying on it.

## Rollback

Unset the secrets to disable; migration 021 is additive.
