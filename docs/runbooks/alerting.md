# Alerting

Set `RELAY_ALERT_WEBHOOK_URL` to an HTTPS endpoint that accepts a Slack-compatible `{"text": "..."}` POST (Slack, Discord with `/slack`, a paging service bridge). The 15-minute scheduled job checks and posts:

| Condition                      | Meaning                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| scheduled job failing or stale | The tick or daily job has not succeeded recently                |
| notifications failed           | Messages failed permanently in the last 24 hours                |
| notifications overdue          | Queued messages are more than an hour late                      |
| exports stalled                | Report exports never started in the last 24 hours               |
| security configuration         | Production is missing a key, secret, origin or malware scanning |

Each condition is announced when it appears, again if its detail changes, and once a day while it lasts. A failed post is retried on the next tick; the alert step never fails the job itself (its result shows in the job run detail as `alerts`). Messages contain counts and check names only, never customer data. If the scheduler itself stops, nothing sends: also point an external uptime monitor at `/api/health` and at the Vercel cron.

**Rollback:** unset the variable; the table `alert_state` is then unused (`DROP TABLE alert_state` removes it).
