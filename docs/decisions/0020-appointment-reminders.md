# 0020 — Appointment reminders to drivers

Status: accepted, 2026-10-21.

## Decision

The existing reminder job (`/api/jobs/notifications`, ADR 0010) also reminds the **assigned driver** about each upcoming stop. A stop qualifies when its load is not cancelled or delivered, its appointment window has not ended, no arrival has been recorded, and the window starts within `RELAY_APPOINTMENT_REMINDER_HOURS` (default 24, allowed 3–72). There are two tiers: a lead reminder, and a "soon" reminder once the window is within two hours. A run sends only the nearest applicable tier.

Reminders are emails through the encrypted outbox, kind `appointment_reminder`, deduplicated by stop + window start + tier + recipient. Running the job more often is therefore safe, and a stop rescheduled through load edit (ADR 0019) is announced again because its window start changed. Drivers can mute the kind in Notifications (migration 018).

## Limits

- The bundled Vercel cron runs once a day (13:07 UTC), so with the default schedule drivers get the day-ahead reminder, and the "soon" tier only fires if the job is run more often. Run the endpoint every 15 minutes from any scheduler that can send the `CRON_SECRET` bearer token to get two-hour reminders. No schedule was changed or paid for.
- Email only. Texting drivers needs their recorded consent (ADR 0018) and is not automatic.
- Reminders do not track whether the driver read them.
