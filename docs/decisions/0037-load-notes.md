# 0037 — Internal notes on a load

## Decision

Dispatchers and a carrier's managers can leave short internal notes on a load (`load_notes`, migration 032). Drivers cannot read or write them and get the same 404 as for a load they cannot see. Notes are append-only (a database trigger refuses UPDATE and DELETE); a correction is a new note. Adding a note is idempotent per author and key (a retry after a lost reply adds one; the same key with different text is a 409) and writes an audit row. A note does not change the load's version, so it never conflicts with a concurrent edit. Notes are staff-internal: nothing is sent to the carrier, broker or driver.

## Why

This is the "notes on a record" idea from CRMs such as Twenty, built for Relay's own isolation rules (ADR 0036: no code reused).

## Rollback

Additive. Leave `load_notes` unused (or drop it); nothing else references it.
