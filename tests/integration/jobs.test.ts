import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import { mutate } from "../../src/lib/loads";
import {
  jobStatus,
  parseScope,
  pruneJobRuns,
  runNotificationJob,
} from "../../src/lib/jobs";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
const SECRET = "fictional-cron-secret-0123456789";
let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  process.env.CRON_SECRET = SECRET;
  t = await tenant("Jobs");
  // Start from a clean slate so state assertions are about these tests.
  await pool.query("DELETE FROM job_runs");
});
after(() => pool.end());

const cron = (scope?: string, secret: string | null = SECRET) =>
  GET(
    request("jobs/notifications" + (scope ? "?scope=" + scope : ""), {
      headers: secret ? { authorization: "Bearer " + secret } : {},
    }),
  );
const runs = async (scope: string) =>
  (
    await pool.query(
      "SELECT outcome,detail,duration_ms,finished_at FROM job_runs WHERE scope=$1 ORDER BY started_at",
      [scope],
    )
  ).rows;
const driverLoad = async (hours: number) => {
  const load = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: hours,
  });
  await mutate(t.dispatcher, load.id, "assign", {
    version: load.version,
    driverId: t.driver,
  });
  return load;
};
const appointment = async (reference: string) =>
  (
    await pool.query(
      "SELECT dedupe_key FROM notifications WHERE kind='appointment_reminder' AND subject LIKE $1",
      ["%" + reference],
    )
  ).rowCount;

test("the endpoint needs the cron secret and a known scope", async () => {
  assert.equal((await cron(undefined, null)).status, 401);
  assert.equal((await cron("tick", "wrong-secret-wrong-secret")).status, 401);
  assert.equal((await cron("hourly")).status, 400);
  assert.throws(() => parseScope("nope"));
  assert.equal(parseScope(null), "daily");
  assert.equal(parseScope("tick"), "tick");
  process.env.CRON_SECRET = "short";
  assert.equal((await cron("tick")).status, 503);
  process.env.CRON_SECRET = SECRET;
});

test("a tick sends appointment reminders and delivery, not the daily sweeps", async () => {
  const soon = await driverLoad(1);
  // A load delivered two days ago with no accepted proof of delivery: a daily
  // item. Events are append-only, so the old milestone is inserted, not edited.
  const pod = await bookedLoad(t.dispatcher, t.carrier);
  await pool.query("UPDATE loads SET stage='delivered' WHERE id=$1", [pod.id]);
  await pool.query(
    "INSERT INTO load_events(id,load_id,carrier_id,actor_id,type,payload,created_at) VALUES($1,$2,$3,$4,'load.milestones','{}',now()-interval '2 days')",
    [randomUUID(), pod.id, t.carrier, t.dispatcher],
  );
  const res = await cron("tick");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "alerts",
    "appointments",
    "delivery",
    "exports",
    "objects",
  ]);
  assert.equal(await appointment(soon.reference), 1);
  const podReminder = await pool.query(
    "SELECT 1 FROM notifications WHERE kind='document_reminder' AND subject LIKE $1",
    ["%" + pod.reference],
  );
  assert.equal(podReminder.rowCount, 0, "tick must not run the daily sweeps");
  // The daily run covers everything the tick does, plus its own steps.
  const daily = await (await cron("daily")).json();
  const afterDaily = await pool.query(
    "SELECT 1 FROM notifications WHERE kind='document_reminder' AND subject LIKE $1",
    ["%" + pod.reference],
  );
  assert.ok(afterDaily.rowCount! >= 1, "the daily sweep does remind");
  assert.deepEqual(Object.keys(daily).sort(), [
    "alerts",
    "appointments",
    "authority",
    "changes",
    "cleanup",
    "credentials",
    "delivery",
    "exports",
    "objects",
    "pruned",
    "reminders",
    "retention",
  ]);
  const bare = await (await cron()).json();
  assert.deepEqual(Object.keys(bare).sort(), Object.keys(daily).sort());
});

test("running a tick again and again never repeats a reminder", async () => {
  const load = await driverLoad(1);
  for (let i = 0; i < 4; i++) assert.equal((await cron("tick")).status, 200);
  assert.equal(await appointment(load.reference), 1);
});

test("every run is recorded with its outcome and duration", async () => {
  const before = (await runs("tick")).length;
  await cron("tick");
  const rows = await runs("tick");
  assert.equal(rows.length, before + 1);
  const last = rows.at(-1)!;
  assert.equal(last.outcome, "ok");
  assert.ok(last.finished_at && last.duration_ms >= 0);
});

test("a failing step is recorded as an error, the message is short, and the error surfaces", async () => {
  await assert.rejects(
    runNotificationJob("tick", {
      first: async () => 1,
      boom: async () => {
        throw new Error("x".repeat(500));
      },
    }),
  );
  const last = (await runs("tick")).at(-1)!;
  assert.equal(last.outcome, "error");
  assert.equal(last.detail.first, 1);
  assert.ok(String(last.detail.error).length <= 200);
  const status = (await jobStatus()).find((s) => s.scope === "tick")!;
  assert.equal(status.state, "failing");
  // The next good run clears it.
  await runNotificationJob("tick", { fine: async () => 1 });
  assert.equal(
    (await jobStatus()).find((s) => s.scope === "tick")!.state,
    "ok",
  );
});

test("a second run of the same scope is skipped while one is running; other scopes are not", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const first = runNotificationJob("tick", {
    hold: async () => {
      entered();
      await gate;
      return "held";
    },
  });
  await inside;
  const before = (await runs("tick")).length;
  assert.deepEqual(await runNotificationJob("tick", { nope: async () => 1 }), {
    skipped: "running",
  });
  const viaHttp = await (await cron("tick")).json();
  assert.deepEqual(viaHttp, { skipped: "running" });
  // Skipped callers leave no record; a different scope still runs.
  assert.equal((await runs("tick")).length, before);
  assert.equal((await cron("daily")).status, 200);
  release();
  assert.deepEqual(await first, { hold: "held" });
});

test("status: never, ok, stale; and old records are pruned", async () => {
  await pool.query("DELETE FROM job_runs");
  const all = await jobStatus();
  assert.deepEqual(
    all.map((s) => [s.scope, s.state]),
    [
      ["tick", "never"],
      ["daily", "never"],
    ],
  );
  await runNotificationJob("tick", { a: async () => 1 });
  assert.equal((await jobStatus())[0].state, "ok");
  await pool.query(
    "UPDATE job_runs SET started_at=now()-interval '2 hours',finished_at=now()-interval '2 hours'",
  );
  assert.equal((await jobStatus())[0].state, "stale");
  assert.ok((await pruneJobRuns(30)) === 0);
  await pool.query(
    "UPDATE job_runs SET started_at=now()-interval '40 days',finished_at=now()-interval '40 days'",
  );
  assert.equal(await pruneJobRuns(30), 1);
});

test("status is visible to organization owners and admins only", async () => {
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [t.organization, t.dispatcher],
  );
  const get = async (user: string) => {
    const res = await GET(
      request("jobs/status", { token: await sessionFor(user) }),
    );
    return { status: res.status, body: await res.json() };
  };
  const admin = await get(t.dispatcher);
  assert.equal(admin.status, 200);
  assert.deepEqual(
    admin.body.jobs.map((j: { scope: string }) => j.scope),
    ["tick", "daily"],
  );
  // Run times and outcomes only.
  assert.deepEqual(Object.keys(admin.body.jobs[0]).sort(), [
    "last_duration_ms",
    "last_outcome",
    "last_run_at",
    "last_success_at",
    "scope",
    "stale_after_minutes",
    "state",
  ]);
  for (const user of [t.manager, t.driverUser, t.foreignManager]) {
    const r = await get(user);
    assert.equal(r.status, 404, user);
    assert.deepEqual(r.body, { error: "NOT_FOUND" });
  }
  assert.equal((await GET(request("jobs/status"))).status, 401);
});
