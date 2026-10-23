# 0056 — Preserve structured assistant results under context limits

Status: accepted, 2026-10-23

## Problem

The browser regression with a growing fictional database reproduced an invalid “Nothing needs attention” answer. The tool returned loads, but the 12,000-character context limit cut its JSON in the middle of a record. The deterministic QA assistant treated parse failure as an empty lookup. A model also could not reliably interpret that broken response.

## Decision

Keep the existing context bound and trim whole records from top-level result arrays until valid JSON fits. Retain an explicit `truncated` flag, update the shown count, and preserve original source data unchanged. If even one complete record cannot fit, return an explicit lookup error. The sample assistant rejects invalid/error responses instead of presenting empty success, and labels an attention/driver subset. The model instructions likewise require subset disclosure and prohibit interpreting lookup errors as empty results. Prompt version becomes `assistant-3` for auditability; existing historical turns retain their recorded version.

This changes neither tool authorization nor the existing human-reviewed drafting exception. No operational mutation, live model connection or additional token budget is enabled.

## Verification and rollback

`assistant.test.ts` checks complete JSON records, bounds, shown counts, source immutability, subset wording and failed/malformed lookups. The existing attention browser journey exercises this against the populated QA database. Revert application code only if needed; no database migration or historical turn rewrite is required.
