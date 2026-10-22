# 0049 Request limits, page security headers, health and the outbox

Status: accepted

## Decision

- **Rate limits.** The sign-in and MFA steps are also limited per client address (60 a minute) on top of the existing per-email limit (8), so one address cannot spray many emails. Every authenticated write shares a per-person budget of 240 a minute, and the assistant and AI document reading have a smaller one of 20 a minute, in addition to the organization's monthly AI spend limit. Reads are not limited. The address is the first `x-forwarded-for` entry (set by Vercel); without a proxy a client can spoof it, which only lets it dodge its own limit. Expired windows are swept on about 2% of calls instead of every call.
- **Page headers.** Every response carries `Content-Security-Policy` (same origin only, no framing, no plugins; inline scripts and styles allowed because Next.js emits them; the object-storage host from `S3_*` is allowed for direct uploads, read at build time, plus any `RELAY_CSP_CONNECT_EXTRA` origins; change them and rebuild) and `Strict-Transport-Security`. A nonce-based CSP would remove `'unsafe-inline'` and is future work.
- **Health.** `GET /api/health` is public and returns only `{status}`: 200 when the database answers, 503 otherwise. It is for load balancers and uptime monitors, not for diagnosis.
- **Outbox.** `outbox_events` rows are written in the same transaction as load, account and onboarding events, but **nothing consumes them yet**: there is no external system to publish to. Email and text delivery use their own queue (ADR 0010). A publisher must be added with the first integration (telematics, accounting, webhooks) and must use `attempts` and `delivered_at` with bounded backoff. Until then the table is a durable record, not a delivery mechanism, and no document should claim otherwise.

## Consequences

No migration. Rollback is reverting the commit. Limits are fixed-window and per database; a shared cache would be needed for several regions. Nothing here sends messages or incurs cost.

## Marketing pages

Copy on the public pages was trimmed so each fact appears once: the early-access and fictional-data disclosure lives in one band on the product page and the plan card on pricing, the duplicated FAQ entries were removed, and call-to-action blocks no longer restate the page. Rows wrap only when full: preview tabs, header and footer links stay on one row where they fit, headings are balanced so no word is left alone, and the plan checklist uses the card's width.
