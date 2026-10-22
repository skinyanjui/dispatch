# 0047 Audit log page

Status: accepted

## Decision

Organization owners and admins get a read-only **Audit log** page (`/audit`, in the account menu beside Organization): who did what, when, to which record, newest first, with filters for action, person, text and date range, and "Show more" paging. The scheduler's state (ADR 0046) sits above the log.

**Data ownership.** The log is still one append-only table, `audit_logs`, written in the same transaction as the change it records, by the code that already writes it. Migration 036 adds a nullable `organization_id` as the last column, so the roughly thirty existing positional `INSERT … VALUES` statements are untouched. A `BEFORE INSERT` trigger fills it from the actor when the actor belongs to exactly one organization (as an owner or admin, or through a carrier). Rows whose actor belongs to several organizations, or to none, or is the system (webhooks, jobs), stay NULL and are shown to nobody: showing a shared person's actions to both organizations would be a cross-tenant leak, and a wrong guess would be worse than a gap.

**Migration (expand → backfill → verify).** Add the column, index and trigger; backfill existing rows by the same rule, with the append-only trigger disabled only for that one `UPDATE` inside the migration's transaction; then a check that no coverable row was missed and that the append-only trigger is enabled again, either of which aborts the migration. Rollback is written at the end of the file (drop trigger, function, index and column).

**Authorization.** Only people in `organization_members` can read it; everyone else, including dispatchers and carrier managers, gets 404 (the same answer as a page that does not exist). Every query is limited to the caller's own organizations; a filter or cursor from another organization returns nothing. Reading the log is itself logged (`audit.viewed`), at most once in ten minutes per person so filtering and paging do not flood it.

**What is shown.** Time, the person's name, a plain-language label for the action (unknown actions show their recorded name), and the record id. No payloads, emails or message text. Paging uses a cursor on (exact microsecond timestamp, id), so rows sharing a timestamp are neither skipped nor repeated.

## Consequences

Retention is unchanged (none yet; needs legal review). The page does not export. Dates in the filter are UTC days; times are shown in the viewer's zone. Search matches the recorded action name, the person's name and the record id, not the plain-language label.
