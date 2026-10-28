import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import { readiness } from "../../src/lib/readiness";
import { readinessItem } from "../../src/lib/readiness-rules";
import { mutate } from "../../src/lib/loads";
import { reviewDocument, uploadDocument } from "../../src/lib/documents";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Readiness");
});
after(() => pool.end());

async function load(deliver: boolean, assign = true) {
  const l = await bookedLoad(t.dispatcher, t.carrier);
  if (!assign) return l;
  let version = (
    await mutate(t.dispatcher, l.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  if (deliver)
    for (const stage of ["dispatched", "picked-up", "delivered"])
      version = (
        await mutate(t.dispatcher, l.id, "milestones", { version, stage })
      ).version;
  return l;
}
async function doc(
  loadId: string,
  type: string,
  decision?: "accepted" | "rejected",
) {
  const v = await uploadDocument(
    t.dispatcher,
    {
      carrier_id: t.carrier,
      load_id: loadId,
      type,
      idempotency_key: randomUUID(),
    },
    { name: type + ".pdf", bytes: pdf() },
  );
  if (decision)
    await reviewDocument(t.dispatcher, v.version_id, {
      decision,
      ...(decision === "rejected" ? { note: "Too blurry to read" } : {}),
    });
}

test("each document says who has to act, and only delivered freight is held up", () => {
  const item = (
    type: "rate_confirmation" | "bol" | "pod",
    status: Parameters<typeof readinessItem>[1],
    delivered = true,
  ) => readinessItem(type, status, delivered);
  assert.deepEqual(
    [
      item("pod", "missing").owed_by,
      item("pod", "missing").blocks_billing,
      item("pod", "missing").action,
    ],
    ["driver", true, "Upload the proof of delivery"],
  );
  assert.equal(item("rate_confirmation", "missing").owed_by, "dispatcher");
  assert.equal(item("pod", "pending_review").owed_by, "dispatcher");
  assert.equal(
    item("pod", "rejected").action,
    "Upload a corrected proof of delivery",
  );
  assert.deepEqual(
    [
      item("pod", "accepted").owed_by,
      item("pod", "accepted").action,
      item("pod", "accepted").blocks_billing,
    ],
    ["none", null, false],
  );
  assert.equal(item("bol", "missing", false).blocks_billing, false);
});

test("the carrier sees held-up loads first, with owners; the driver sees only their own to-do", async () => {
  const none = await load(true);
  const review = await load(true);
  await doc(review.id, "rate_confirmation", "accepted");
  await doc(review.id, "bol", "accepted");
  await doc(review.id, "pod");
  const rejected = await load(true);
  await doc(rejected.id, "rate_confirmation", "accepted");
  await doc(rejected.id, "bol", "accepted");
  await doc(rejected.id, "pod", "rejected");
  const complete = await load(true);
  for (const type of ["rate_confirmation", "bol", "pod"])
    await doc(complete.id, type, "accepted");
  const early = await load(false);
  const unassigned = await load(false, false);

  const view = await readiness(t.manager, t.carrier);
  const by = (id: string) => view.loads.find((l) => l.id === id)!;
  assert.equal(view.scope, "carrier");
  assert.equal(by(complete.id), undefined);
  assert.deepEqual(
    by(none.id).items.map((i) => [i.type, i.owed_by]),
    [
      ["rate_confirmation", "dispatcher"],
      ["bol", "driver"],
      ["pod", "driver"],
    ],
  );
  assert.equal(by(none.id).blocks_billing, true);
  assert.equal(by(none.id).days_outstanding, 0);
  assert.deepEqual(
    by(review.id).items.map((i) => [i.type, i.owed_by, i.action]),
    [["pod", "dispatcher", "Review the proof of delivery"]],
  );
  assert.deepEqual(
    by(rejected.id).items.map((i) => [i.owed_by, i.action]),
    [["driver", "Upload a corrected proof of delivery"]],
  );
  // Freight not yet delivered is listed, but does not hold up billing.
  assert.equal(by(early.id).blocks_billing, false);
  assert.ok(by(early.id).items.length > 0);
  assert.equal(by(unassigned.id).driver, null);
  // Held-up loads sort ahead of the rest.
  const order = view.loads.map((l) => l.blocks_billing);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => Number(b) - Number(a)),
  );
  assert.ok(view.summary.blocking_billing >= 3);
  assert.ok(
    view.summary.waiting_on_driver >= 2 &&
      view.summary.waiting_on_dispatcher >= 1,
  );

  // The assigned driver sees only what waits on drivers, only on their loads.
  const mine = await readiness(t.driverUser, t.carrier);
  assert.equal(mine.scope, "my_loads");
  assert.ok(mine.loads.length >= 2);
  assert.ok(
    mine.loads.every((l) => l.items.every((i) => i.owed_by === "driver")),
  );
  assert.equal(
    mine.loads.some((l) => l.id === review.id),
    false,
  ); // only waits on a dispatcher
  assert.equal(
    mine.loads.some((l) => l.id === unassigned.id),
    false,
  );
  // Another driver of the same carrier has no assigned loads.
  assert.equal((await readiness(t.otherDriverUser, t.carrier)).loads.length, 0);
});

test("HTTP: other carriers' people get 404 and a missing carrier is a field error", async () => {
  const call = async (path: string, user: string) =>
    (await GET(request(path, { token: await sessionFor(user) }))).status;
  const path = "documents/readiness?carrier_id=" + t.carrier;
  for (const user of [t.dispatcher, t.manager, t.driverUser])
    assert.equal(await call(path, user), 200);
  assert.equal(await call(path, t.foreignManager), 404);
  assert.equal(
    await call("documents/readiness?carrier_id=" + t.foreign, t.manager),
    404,
  );
  assert.equal(await call("documents/readiness", t.manager), 400);
});
