# 0004 — Manual observations with immutable provenance

Status: accepted, 2026-10-21.

The prototype supported manual check-ins, but the authenticated application had no observation workflow. Add `check_ins` as authoritative append-only records, linked to the load and its carrier through a composite foreign key. A report contains free-text approximate location, optional note, observation time, server receipt time and authenticated actor. Source is fixed to `manual`; callers cannot supply a provider or impersonate another actor. No GPS, telematics, outbound messaging or tracking permission is introduced.

Dispatchers and carrier managers may record within existing membership scope. A driver may record only for their currently assigned load. Check assignment both before acquiring a row lock and after waiting for concurrent writers. Recording after an expired dispatch agreement remains allowed: the operation records history and does not create, assign or transfer booked freight. All permissions still apply to idempotent replays, including after a driver is reassigned.

Each accepted new observation checks the expected load version, increments that version, and atomically writes an observation, domain event, outbox entry and audit row. Milestone state remains independent. Store actor-scoped UUID idempotency keys and request hashes with the immutable observation. An exact retry returns its original result before current version/time validation, so uncertain responses remain recoverable after subsequent operations. Changed payloads conflict. UI retries preserve the original key and version even after a detail refresh; a known version conflict permits a fresh attempt after review.

Accept observed times within the last 30 days and no more than five minutes ahead, allowing modest clock skew while preventing obvious future reports. The UI rejects ambiguous/nonexistent local daylight saving times, displays actual observation and recording timestamps, and labels reports stale after two hours. That threshold is a display convention, not an SLA. Sort by observation time, then receipt time and ID, so late entry does not replace a newer observation.

Detail returns the latest 50 observations and 100 events, disclosing truncated activity. All older records remain stored; pagination/export and correction via superseding observations are deferred. Carrier scope, source timestamps, durable retries and data provenance remain required if provider integrations are added.

Migration 003 is additive and requires no backfill or downtime for old writers. Apply it before deploying the new application. To roll back, restore the previous application while retaining the table and trigger. Do not drop observations or remove migration history to reverse an application deployment. The runner intentionally has no destructive down migration. Verify migrations from an empty QA database and rerun them before release.
