# 0065 Carrier authority and insurance monitoring

Status: accepted, 2026-10-24.

## Context

Research found fake and hijacked carrier registrations, sold MC numbers and impersonated dispatch providers among the main harms, and that carriers and dispatchers already depend on third-party monitoring. Relay verifies a written dispatch authorization (ADR 0006) and tracks insurance documents, but never looked at whether the carrier's public registration still says it may operate.

## Decision

- **Lookups are observations.** `carrier_authority_checks` (migration 043, append-only) stores each lookup: USDOT number, source, outcome (`ok`, `not_found`, `error`), registered name, authority status, allowed to operate, out of service, insurance on file, and when it was observed. Screens show source and age; a result older than 72 hours is "stale", never "clear".
- **Findings raise flags; nothing blocks automatically.** `authority-state.ts` derives `clear`, `attention`, `unverified` or `unchecked` and the flags (no such USDOT, not allowed to operate, authority inactive or revoked, out of service, no insurance on file, name differs, lookup failed, stale). A failed lookup never hides the last good result, and a known problem stays a problem while the registry is unreachable. Blocking booking on a registry flag is a deliberate non-goal until false positives are understood; a person decides.
- **Providers.** `fixture` is fictional and deterministic (last digit selects a state) for development, tests and demos. `fmcsa` calls the public QCMobile service; opt in with `RELAY_AUTHORITY_PROVIDER=fmcsa` and `FMCSA_WEBKEY`. Its parser follows the documented response shape and has not been run against the live service from this repository. In production, with neither configured, a check answers 503 `AUTHORITY_PROVIDER_NOT_CONFIGURED` and the job skips, so a fictional result is never recorded as real; `RELAY_AUTHORITY_PROVIDER=fixture` allows it on purpose.
- **When.** A dispatcher or carrier manager can "check now" (idempotent, audited as `authority.checked`). The daily job re-checks carriers with finished setup and a USDOT number whose last check is over 20 hours old, at most 50 per run. A failed lookup is retried after an hour until four failures in a row, then daily. Failure codes come from a fixed vocabulary (`PROVIDER_HTTP_nnn`, `TIMEOUT`, `LOOKUP_FAILED`), never the provider's message.
- **Alert.** Carriers whose latest state is `attention` are counted in the operations alert (`authority.attention`).
- **Access.** `authority` is a non-driver API family; reads and checks need dispatcher or carrier-manager membership of that carrier, otherwise 404.

## Consequences

MC and docket numbers are not stored yet; USDOT is the lookup key. The registry can lag or be wrong, which is why the result is a flag with a timestamp. Paid verification vendors (identity proofing, continuous monitoring) are a later decision and would be another provider behind the same seam. Rollback: leave the table; remove the job step.
