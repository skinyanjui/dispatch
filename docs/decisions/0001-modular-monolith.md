# ADR 0001 — Modular monolith and carrier-tenant boundaries

Status: Accepted for initial development

## Context
Relay is a dispatch service operated as an authorized agent for independent motor carriers. The tool needs a coherent load lifecycle with low operational overhead and strict carrier isolation.

## Decision
Use a modular monolith with typed authenticated API routes, relational PostgreSQL authority for transactional records, append-only load events and a transactional outbox for integrations. Every load has exactly one authorized carrier at the time of booking, and separate operational/document/billing state machines.

## Consequences
- Easier transactional integrity, fewer distributed failure modes and simpler operations at launch.
- All tenant-aware access paths must prove carrier authorization; no client-only filtering.
- Existing single HTML demo is a reference, not the long-term authoritative architecture.
- Services may be extracted only for proven scaling/availability needs.
