import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import {
  createLoad,
  detail,
  mutate,
  recordStopEvent,
} from "../../src/lib/loads";
import { cancelLoad } from "../../src/lib/load-changes";
import { openException } from "../../src/lib/exceptions";
import { csvCell, loadsCsv, reportOverview } from "../../src/lib/reports";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Reports");
});
after(() => pool.end());

const overview = (user: string, carrier: string, extra = "") =>
  reportOverview(user, new URLSearchParams(`carrier_id=${carrier}${extra}`));
const arrive = async (loadId: string, minutesAfterWindowEnd: number) => {
  const d = await detail(t.dispatcher, loadId);
  const end = new Date(d.stops[0].window_end).getTime();
  return recordStopEvent(t.dispatcher, loadId, d.stops[0].id, {
    version: d.version,
    kind: "arrived",
    occurred_at: new Date(end + minutesAfterWindowEnd * 60000).toISOString(),
    idempotency_key: randomUUID(),
  });
};

test("loads, freight value, on-time and exceptions are counted for the chosen carrier only", async () => {
  // Pickups two days ago, so they fall in the default range and are measurable.
  const early = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  const late = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  const gone = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  const done = await bookedLoad(t.dispatcher, t.carrier, {
    pickupHoursFromNow: -48,
  });
  await bookedLoad(t.dispatcher, t.foreign, { pickupHoursFromNow: -48 });
  await arrive(early.id, -10);
  await arrive(late.id, 25);
  await cancelLoad(t.dispatcher, gone.id, {
    version: (await detail(t.dispatcher, gone.id)).version,
    reason: "Test",
  });
  let v = done.version;
  await mutate(t.dispatcher, done.id, "assign", {
    version: v,
    driverId: t.driver,
  });
  v++;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    v = (
      await mutate(t.dispatcher, done.id, "milestones", { version: v, stage })
    ).version;
  await openException(t.dispatcher, early.id, {
    idempotency_key: randomUUID(),
    type: "delay",
    severity: "low",
    summary: "Weather",
  });
  const r = await overview(t.dispatcher, t.carrier);
  assert.equal(r.loads.loads, 3);
  assert.equal(r.loads.cancelled, 1);
  assert.equal(r.loads.delivered, 1);
  assert.equal(r.loads.freight_minor, "750000"); // cancelled load excluded
  assert.deepEqual(
    [
      r.timing.pickup.measured,
      r.timing.pickup.on_time,
      r.timing.pickup.on_time_pct,
    ],
    [2, 1, 50],
  );
  assert.equal(r.exceptions.open_now, 1);
  assert.equal(r.exceptions.by_type[0].type, "delay");
  assert.equal(r.delivered_without_pod, 1);
  assert.equal(r.carriers.length, 1);
  assert.equal(r.carriers[0].loads, 3);
  assert.equal(
    r.weekly.reduce((n: number, w: { loads: number }) => n + w.loads, 0),
    3,
  );
  // Money stays text (bigint minor units), never a float.
  assert.equal(typeof r.loads.freight_minor, "string");
});

test("reports are scoped by membership and refuse drivers, other tenants and bad ranges", async () => {
  const mine = await overview(t.manager, t.carrier);
  assert.ok(mine.loads.loads >= 3);
  assert.equal(mine.dispatch_invoices, null); // fee invoices are for dispatchers
  const foreign = await overview(t.foreignManager, t.foreign);
  assert.equal(foreign.loads.loads, 1);
  assert.ok(foreign.carriers.every((c: { id: string }) => c.id === t.foreign));
  await assert.rejects(overview(t.foreignManager, t.carrier), {
    code: "NOT_FOUND",
  });
  await assert.rejects(overview(t.driverUser, t.carrier), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    overview(t.dispatcher, t.carrier, "&from=2026-01-10&to=2026-01-01"),
    { code: "INVALID_RANGE" },
  );
  await assert.rejects(
    overview(t.dispatcher, t.carrier, "&from=2020-01-01&to=2026-01-01"),
    { code: "INVALID_RANGE" },
  );
  await assert.rejects(overview(t.dispatcher, t.carrier, "&from=garbage"));
  const none = await overview(
    t.dispatcher,
    t.carrier,
    "&from=2000-01-01&to=2000-01-31",
  );
  assert.equal(none.loads.loads, 0);
  assert.equal(none.timing.pickup.on_time_pct, null);
  const dispatcher = await overview(t.dispatcher, t.carrier);
  assert.ok(dispatcher.dispatch_invoices);
});

test("CSV export neutralises formulas and respects scope", async () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell(null), "");
  const stop = (kind: string, h: number) => ({
    kind,
    address: "Dallas, TX",
    timezone: "America/Chicago",
    windowStart: new Date(Date.now() + h * 3600000).toISOString(),
    windowEnd: new Date(Date.now() + (h + 1) * 3600000).toISOString(),
  });
  await createLoad(
    t.dispatcher,
    {
      carrierId: t.carrier,
      reference: "=CMD|' /C calc'!A0",
      source: "Fictional",
      amountMinor: 12345,
      stops: [stop("pickup", -20), stop("delivery", -5)],
    },
    randomUUID(),
  );
  const file = await loadsCsv(
    t.manager,
    new URLSearchParams(`carrier_id=${t.carrier}`),
  );
  assert.match(file.csv.split("\r\n")[0], /^Reference,Carrier,Status/);
  assert.ok(file.csv.includes("'=CMD|"));
  assert.ok(!file.csv.includes("\n=CMD"));
  assert.ok(file.csv.includes("123.45"));
  assert.match(file.filename, /^relay-loads-\d{4}-\d{2}-\d{2}-to-/);
  await assert.rejects(
    loadsCsv(t.foreignManager, new URLSearchParams(`carrier_id=${t.carrier}`)),
    { code: "NOT_FOUND" },
  );
  const audit = await pool.query(
    "SELECT 1 FROM audit_logs WHERE action='report.exported' AND actor_id=$1",
    [t.manager],
  );
  assert.equal(audit.rowCount, 1);
});

test("HTTP: reports need a session; CSV downloads as an attachment", async () => {
  assert.equal(
    (await GET(request(`reports?carrier_id=${t.carrier}`))).status,
    401,
  );
  const token = await sessionFor(t.manager);
  const json = await GET(request(`reports?carrier_id=${t.carrier}`, { token }));
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("cache-control"), "private, no-store");
  const csv = await GET(
    request(`reports/loads.csv?carrier_id=${t.carrier}`, { token }),
  );
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") || "", /^text\/csv/);
  assert.match(csv.headers.get("content-disposition") || "", /^attachment/);
  const forbidden = await GET(
    request(`reports?carrier_id=${t.carrier}`, {
      token: await sessionFor(t.foreignManager),
    }),
  );
  assert.equal(forbidden.status, 404);
});
