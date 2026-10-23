import test, { after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/lib/db";
import { sendAlerts } from "../../src/lib/alerts";
import type { JobStatus } from "../../src/lib/jobs";

after(() => pool.end());

const failing: JobStatus = {
  scope: "tick",
  state: "failing",
  last_run_at: null,
  last_success_at: null,
  last_outcome: "error",
  last_duration_ms: null,
  stale_after_minutes: 45,
};
const healthy: JobStatus = { ...failing, state: "ok", last_outcome: "ok" };

test("a standing problem is announced once, again if it changes, and after it clears", async () => {
  process.env.RELAY_ALERT_WEBHOOK_URL = "https://alerts.example/hook";
  await pool.query("DELETE FROM alert_state");
  const bodies: string[] = [];
  const post = async (_url: string, body: string) => {
    bodies.push(body);
    return new Response("ok");
  };
  try {
    const first = await sendAlerts([failing], post);
    assert.equal(first.configured && first.sent >= 1, true);
    const sentFirst = bodies.length;
    assert.match(bodies[0], /tick scheduled job is failing/);
    // Unchanged: not repeated on the next tick.
    await sendAlerts([failing], post);
    assert.equal(bodies.length, sentFirst);
    // Cleared, then back: announced again.
    await sendAlerts([healthy], post);
    await sendAlerts([failing], post);
    assert.equal(bodies.length, sentFirst + 1);
    // A failed delivery is not recorded as sent, so it is retried.
    await pool.query("DELETE FROM alert_state");
    await assert.rejects(
      sendAlerts([failing], async () => new Response("no", { status: 500 })),
      /answered 500/,
    );
    assert.equal(
      (await pool.query("SELECT 1 FROM alert_state WHERE key='job:tick'"))
        .rowCount,
      0,
    );
    // Nothing to do, and nothing sent, without a webhook.
    delete process.env.RELAY_ALERT_WEBHOOK_URL;
    assert.deepEqual(await sendAlerts([failing], post), { configured: false });
    process.env.RELAY_ALERT_WEBHOOK_URL = "http://insecure.example";
    await assert.rejects(sendAlerts([failing], post), /https/);
  } finally {
    delete process.env.RELAY_ALERT_WEBHOOK_URL;
    await pool.query("DELETE FROM alert_state");
  }
});
