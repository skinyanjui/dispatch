import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  amendCheckIn,
  detail,
  mutate,
  olderCheckIns,
  olderEvents,
  recordCheckIn,
} from "../../src/lib/loads";
import type { Load } from "../../src/lib/contracts";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("History");
});
after(() => pool.end());

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60000).toISOString();
const view = async (user: string, id: string) =>
  (await detail(user, id)) as Load;

test("corrections overlay the immutable original; retraction is final and audited", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  let v = (
    await mutate(t.dispatcher, load.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  const report = await recordCheckIn(t.driverUser, load.id, {
    version: v,
    location: "Jolliet, IL",
    note: "",
    observed_at: minutesAgo(30),
    idempotency_key: randomUUID(),
  });
  v = report.version;
  const key = randomUUID();
  const correction = {
    action: "correct",
    version: v,
    location: "Joliet, IL",
    note: "Fixed spelling",
    observed_at: minutesAgo(25),
    reason: "Typo in the city name",
    idempotency_key: key,
  };
  v = (
    await amendCheckIn(t.driverUser, load.id, report.check_in_id, correction)
  ).version;
  // An exact retry replays; a changed retry under the same key conflicts.
  assert.equal(
    (await amendCheckIn(t.driverUser, load.id, report.check_in_id, correction))
      .version,
    v,
  );
  await assert.rejects(
    amendCheckIn(t.driverUser, load.id, report.check_in_id, {
      ...correction,
      location: "Elsewhere",
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  let current = (await view(t.manager, load.id)).check_ins![0];
  assert.equal(current.status, "corrected");
  assert.equal(current.location, "Joliet, IL");
  assert.equal(current.original?.location, "Jolliet, IL");
  assert.equal(current.amendments?.[0].reason, "Typo in the city name");
  const original = await pool.query(
    "SELECT location FROM check_ins WHERE id=$1",
    [report.check_in_id],
  );
  assert.equal(original.rows[0].location, "Jolliet, IL");
  await assert.rejects(
    amendCheckIn(t.manager, load.id, report.check_in_id, {
      action: "retract",
      version: v - 1,
      reason: "stale version",
      idempotency_key: randomUUID(),
    }),
    { code: "VERSION_CONFLICT" },
  );
  v = (
    await amendCheckIn(t.manager, load.id, report.check_in_id, {
      action: "retract",
      version: v,
      reason: "Driver reported the wrong load",
      idempotency_key: randomUUID(),
    })
  ).version;
  current = (await view(t.manager, load.id)).check_ins![0];
  assert.equal(current.status, "retracted");
  assert.equal(current.amendments?.length, 2);
  await assert.rejects(
    amendCheckIn(t.manager, load.id, report.check_in_id, {
      ...correction,
      version: v,
      idempotency_key: randomUUID(),
    }),
    { code: "CHECK_IN_RETRACTED" },
  );
  const events = await pool.query(
    "SELECT type FROM load_events WHERE load_id=$1 AND type LIKE 'load.check-in%' ORDER BY created_at",
    [load.id],
  );
  assert.deepEqual(
    events.rows.map((r) => r.type),
    ["load.check-in", "load.check-in-correct", "load.check-in-retract"],
  );
  await assert.rejects(
    pool.query(
      "UPDATE check_in_amendments SET reason='x' WHERE check_in_id=$1",
      [report.check_in_id],
    ),
    /Append-only record/,
  );
});

test("drivers amend only their own reports on assigned loads; other carriers get 404", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  let v = (
    await mutate(t.dispatcher, load.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  const managerReport = await recordCheckIn(t.manager, load.id, {
    version: v,
    location: "Gary, IN",
    note: "",
    observed_at: minutesAgo(10),
    idempotency_key: randomUUID(),
  });
  v = managerReport.version;
  const retract = (version: number) => ({
    action: "retract",
    version,
    reason: "Not mine",
    idempotency_key: randomUUID(),
  });
  await assert.rejects(
    amendCheckIn(t.driverUser, load.id, managerReport.check_in_id, retract(v)),
    { code: "ROLE_NOT_PERMITTED" },
  );
  await assert.rejects(
    amendCheckIn(
      t.otherDriverUser,
      load.id,
      managerReport.check_in_id,
      retract(v),
    ),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    amendCheckIn(
      t.foreignManager,
      load.id,
      managerReport.check_in_id,
      retract(v),
    ),
    { code: "NOT_FOUND" },
  );
  // A check-in ID from another load is not found on this one.
  const other = await bookedLoad(t.dispatcher, t.carrier);
  await assert.rejects(
    amendCheckIn(t.manager, other.id, managerReport.check_in_id, retract(1)),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    amendCheckIn(t.manager, load.id, managerReport.check_in_id, {
      action: "correct",
      version: v,
      location: "Gary, IN",
      note: "",
      observed_at: new Date(Date.now() + 3600000).toISOString(),
      reason: "Future",
      idempotency_key: randomUUID(),
    }),
    { code: "CHECK_IN_TIME_OUT_OF_RANGE" },
  );
});

test("older events and check-ins page with exact microsecond cursors", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  let v = 1;
  for (let i = 0; i < 120; i++)
    v = (
      await recordCheckIn(t.manager, load.id, {
        version: v,
        location: "Mile " + i,
        note: "",
        observed_at: minutesAgo(600 - i),
        idempotency_key: randomUUID(),
      })
    ).version;
  const first = await view(t.dispatcher, load.id);
  assert.equal(first.events!.length, 100);
  assert.ok(first.events_cursor);
  assert.equal(first.check_ins!.length, 50);
  assert.equal(first.check_ins![0].location, "Mile 119");
  const seenEvents = new Set(first.events!.map((e) => e.id));
  let cursor: string | null | undefined = first.events_cursor;
  while (cursor) {
    const page = await olderEvents(
      t.dispatcher,
      load.id,
      new URLSearchParams({ before: cursor }),
    );
    for (const e of page.events) {
      assert.ok(!seenEvents.has(e.id), "no event repeats across pages");
      seenEvents.add(e.id);
    }
    cursor = page.cursor;
  }
  assert.equal(seenEvents.size, 121); // load.created + 120 check-ins
  const seen = first.check_ins!.map((r) => r.location);
  cursor = first.check_ins_cursor;
  while (cursor) {
    const page = await olderCheckIns(
      t.dispatcher,
      load.id,
      new URLSearchParams({ before: cursor }),
    );
    seen.push(...page.check_ins.map((r: { location: string }) => r.location));
    cursor = page.cursor;
  }
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.equal(seen.at(-1), "Mile 0");
  // Paging is scoped and validates cursors.
  await assert.rejects(
    olderEvents(
      t.foreignManager,
      load.id,
      new URLSearchParams({ before: first.events_cursor! }),
    ),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    olderEvents(t.dispatcher, load.id, new URLSearchParams({ before: "bad" })),
    { code: "INVALID_CURSOR" },
  );
  const token = await sessionFor(t.manager);
  const http = await GET(
    request(`loads/${load.id}/check-ins?before=${first.check_ins_cursor}`, {
      token,
    }),
  );
  assert.equal(http.status, 200);
  assert.equal((await http.json()).check_ins.length, 50);
  const amend = await POST(
    request(`loads/${load.id}/check-ins/${randomUUID()}/amend`, {
      token,
      json: {
        action: "retract",
        version: v,
        reason: "x",
        idempotency_key: randomUUID(),
      },
    }),
  );
  assert.equal(amend.status, 404);
});
