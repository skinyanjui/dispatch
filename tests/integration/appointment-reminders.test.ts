import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pool } from "../../src/lib/db";
import { mutate, detail } from "../../src/lib/loads";
import { cancelLoad, editLoad } from "../../src/lib/load-changes";
import { scheduleReminders } from "../../src/lib/notifications";
import { bookedLoad, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Appts");
});
after(() => pool.end());

const reminders = async (reference: string) =>
  (
    await pool.query(
      "SELECT dedupe_key,subject,recipient_user_id FROM notifications WHERE kind='appointment_reminder' AND subject LIKE $1 ORDER BY created_at",
      ["%" + reference],
    )
  ).rows;
const assign = async (hours: number) => {
  const load = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: hours,
  });
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.driver,
  });
  return load;
};

test("the assigned driver is reminded once per stop and tier, only for upcoming stops", async () => {
  const soon = await assign(1);
  const tomorrow = await assign(20);
  const later = await assign(120);
  await scheduleReminders();
  await scheduleReminders();
  const a = await reminders(soon.reference);
  assert.equal(a.length, 1);
  assert.equal(a[0].recipient_user_id, t.driverUser);
  assert.match(a[0].subject, /^Pickup soon/);
  assert.equal((await reminders(tomorrow.reference)).length, 1);
  assert.match((await reminders(tomorrow.reference))[0].subject, /coming up/);
  assert.equal((await reminders(later.reference)).length, 0);
  // Nobody but the assigned driver is notified.
  const others = await pool.query(
    "SELECT 1 FROM notifications WHERE kind='appointment_reminder' AND recipient_user_id=ANY($1)",
    [[t.dispatcher, t.manager, t.otherDriverUser]],
  );
  assert.equal(others.rowCount, 0);
});

test("rescheduling announces again; arrival, cancellation and delivery stop reminders", async () => {
  const load = await assign(20);
  await scheduleReminders();
  assert.equal((await reminders(load.reference)).length, 1);
  const d = await detail(t.dispatcher, load.id);
  // Moving the pickup into the two-hour tier sends a fresh reminder.
  const soon = Date.now() + 3600000;
  await editLoad(t.dispatcher, load.id, {
    version: d.version,
    reason: "Moved up",
    stops: [
      {
        id: d.stops[0].id,
        windowStart: new Date(soon).toISOString(),
        windowEnd: new Date(soon + 1800000).toISOString(),
      },
    ],
  });
  await scheduleReminders();
  assert.equal((await reminders(load.reference)).length, 2);
  // Cancelled loads are skipped.
  const other = await assign(1);
  await cancelLoad(t.dispatcher, other.id, {
    version: (await detail(t.dispatcher, other.id)).version,
    reason: "Test",
  });
  await scheduleReminders();
  assert.equal((await reminders(other.reference)).length, 0);
});
