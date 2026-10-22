import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/lib/db";
import { reportOverview } from "../../src/lib/reports";
import { bookedLoad, tenant } from "./fixtures";

// Report and audit ranges are UTC dates (ADR 0024) whatever timezone the
// database session runs in. Every connection here is moved west of UTC to prove it.
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'America/Los_Angeles'");
});

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("UtcRanges");
});
after(() => pool.end());

test("a pickup at 02:00 UTC on Monday is in Monday's range and week, not Sunday's", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  // Sunday 18:00 in Los Angeles, Monday 02:00 in UTC.
  await pool.query(
    "UPDATE load_stops SET window_start='2026-03-09T02:00:00Z',window_end='2026-03-09T03:00:00Z' WHERE load_id=$1 AND sequence=1",
    [load.id],
  );
  const run = (day: string) =>
    reportOverview(
      t.dispatcher,
      new URLSearchParams(`carrier_id=${t.carrier}&from=${day}&to=${day}`),
    );
  const monday = await run("2026-03-09");
  assert.equal(monday.loads.loads, 1);
  assert.deepEqual(
    monday.weekly.map((w: { week: string }) => w.week),
    ["2026-03-09"],
  );
  assert.equal((await run("2026-03-08")).loads.loads, 0);
});
