# 0035 — Inbox: per-person unread, archive and trash

## Context

Read state was one row per person and conversation, so the inbox could not mark a conversation unread, archive it, delete it, or show counts per tab.

## Decision

- A new table `thread_states(thread_id, user_id, archived_at, trashed_at, marked_unread_at)` (migration 031) holds state for one person. Other participants never see it.
- **Nothing is deleted.** Messages carry attachments, delivery history and audit records, so "delete" means _Move to trash_: hidden from every list and count for that person and restorable. There is no permanent delete in this change; if a retention policy needs one it should be a separate, audited operator action.
- A conversation counts as archived or trashed only while its last message is not newer than the timestamp. A new message therefore brings it back to the inbox with no write, like email.
- Unread is a message from someone else after you last read, **or** a mark-unread after you last read. Opening a conversation clears the mark. The unread badge and the tab counts ignore archived and trashed conversations.
- Routes: `POST threads/:id/{unread,archive,unarchive,trash,restore}` (idempotent, `lockThread` so unknown or foreign conversations are 404), `GET threads/counts`, and `view=inbox|archived|trash` on the list. No audit row: these are personal preferences that change no shared record and send nothing.

## Also in this change

`GET carriers/summary` returns, for carriers the person dispatches or manages, the dispatch authorization state (same verified, in-effect, unexpired test as booking; "expiring" within 30 days), loads, open exceptions and drivers. Drivers get 404.

## Rollback

Both are additive. Leave `thread_states` unused (or drop it) and the code paths that read it fall back to the previous behaviour once reverted; no existing column changed.
