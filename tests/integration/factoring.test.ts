import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  recordCarrierReceipt,
  savePacket,
  submitPacket,
} from "../../src/lib/billing";
import {
  decideChange,
  requestPayoutChange,
} from "../../src/lib/change-control";
import {
  batchFile,
  createBatch,
  factoringOverview,
  markHandedOff,
  releaseBatchLoads,
  saveFactoringSettings,
  voidBatch,
} from "../../src/lib/factoring";
import { mutate } from "../../src/lib/loads";
import { reviewDocument, uploadDocument } from "../../src/lib/documents";
import {
  bookedLoad,
  pdf,
  request,
  sessionFor,
  tenant,
  withPassword,
} from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Factoring");
});
after(() => pool.end());

async function billed(
  billTo = "Fictional Broker LLC",
  complete = true,
  packet = true,
) {
  const l = await bookedLoad(t.dispatcher, t.carrier);
  let version = (
    await mutate(t.dispatcher, l.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    version = (
      await mutate(t.dispatcher, l.id, "milestones", { version, stage })
    ).version;
  const types = complete
    ? ["rate_confirmation", "bol", "pod"]
    : ["rate_confirmation"];
  for (const type of types) {
    const v = await uploadDocument(
      t.dispatcher,
      {
        carrier_id: t.carrier,
        load_id: l.id,
        type,
        idempotency_key: randomUUID(),
      },
      { name: type + ".pdf", bytes: pdf() },
    );
    await reviewDocument(t.dispatcher, v.version_id, { decision: "accepted" });
  }
  if (packet) {
    const v = (
      await savePacket(t.manager, l.id, {
        version: 0,
        bill_to: billTo,
        carrier_invoice_number: "INV-" + l.id.slice(0, 6),
        amount_minor: 250000,
      })
    ).version;
    if (complete) await submitPacket(t.manager, l.id, { version: v });
  }
  return l;
}
const enable = (user = t.manager, over: Record<string, unknown> = {}) =>
  saveFactoringSettings(user, {
    carrier_id: t.carrier,
    enabled: true,
    factor_name: "Fictional Factor Co",
    consent: true,
    ...over,
  });
const batch = (loadIds: string[], key = randomUUID(), user = t.dispatcher) =>
  createBatch(user, { carrier_id: t.carrier, load_ids: loadIds, key });
async function payout(
  coolingHours: string,
  to: { payee_name: string; method: string } = {
    payee_name: "Fictional Factor Co",
    method: "factor",
  },
) {
  process.env.RELAY_PAYOUT_COOLING_HOURS = coolingHours;
  const { id } = (await requestPayoutChange(t.dispatcher, {
    carrier_id: t.carrier,
    ...to,
    account_last4: "9988",
    reason: "Moved to factoring",
    key: randomUUID(),
  })) as { id: string };
  await decideChange(t.manager, id, {
    decision: "approve",
    verification: "callback",
    password: await withPassword(t.manager),
  });
  delete process.env.RELAY_PAYOUT_COOLING_HOURS;
}

test("only the carrier's manager can agree to share billing data, and it needs explicit consent", async () => {
  await assert.rejects(enable(t.dispatcher), { code: "NOT_FOUND" });
  await assert.rejects(enable(t.foreignManager), { code: "NOT_FOUND" });
  await assert.rejects(enable(t.manager, { consent: false }), {
    name: "ZodError",
  });
  await assert.rejects(enable(t.manager, { factor_name: "" }), {
    name: "ZodError",
  });
  assert.equal(
    (await factoringOverview(t.dispatcher, t.carrier)).can_consent,
    false,
  );
  const on = await enable();
  assert.deepEqual([on.enabled, on.factor_name], [true, "Fictional Factor Co"]);
  assert.ok(on.consented_at && on.consented_by);
  assert.equal(
    (await factoringOverview(t.manager, t.carrier)).can_consent,
    true,
  );
  // Disabled, it stops offering loads; turning it back on records consent again.
  await saveFactoringSettings(t.manager, {
    carrier_id: t.carrier,
    enabled: false,
    factor_name: "Fictional Factor Co",
  });
  assert.equal(
    (await factoringOverview(t.dispatcher, t.carrier)).loads.length,
    0,
  );
  await enable();
});

test("a schedule needs payout details in force and loads that are delivered, documented, billed and unpaid", async () => {
  const ok = await billed('=HYPERLINK("http://evil.test")');
  const noPacket = await billed("X", false, false);
  const draft = await billed("X", false, true);
  const paid = await billed();
  await recordCarrierReceipt(t.manager, paid.id, {
    amount_minor: 250000,
    received_on: "2026-10-20",
    reference: "ACH",
    idempotency_key: randomUUID(),
  });
  const early = await bookedLoad(t.dispatcher, t.carrier);

  await saveFactoringSettings(t.manager, {
    carrier_id: t.carrier,
    enabled: false,
    factor_name: "Fictional Factor Co",
  });
  await assert.rejects(batch([ok.id]), { code: "FACTORING_NOT_ENABLED" });
  await enable();
  await assert.rejects(batch([ok.id]), { code: "PAYOUT_DETAILS_REQUIRED" });
  await payout("24");
  await assert.rejects(batch([ok.id]), { code: "PAYOUT_DETAILS_COOLING_OFF" });
  assert.equal(
    (await factoringOverview(t.manager, t.carrier)).payout_cooling_off,
    true,
  );
  // Payout details that pay someone else, or by another method, do not serve a
  // schedule for this factor (ADR 0071).
  for (const to of [
    { payee_name: "Some Other Person", method: "ach" },
    { payee_name: "Some Other Person", method: "factor" },
    { payee_name: "Fictional Factor Co", method: "ach" },
  ]) {
    await payout("0", to);
    await assert.rejects(batch([ok.id]), { code: "PAYOUT_NOT_TO_FACTOR" });
    const o = await factoringOverview(t.manager, t.carrier);
    assert.deepEqual([o.payout_in_force, o.payout_names_factor], [true, false]);
  }
  await payout("0");
  assert.equal(
    (await factoringOverview(t.manager, t.carrier)).payout_names_factor,
    true,
  );
  assert.equal(
    (await factoringOverview(t.manager, t.carrier)).payout_in_force,
    true,
  );

  const view = await factoringOverview(t.dispatcher, t.carrier);
  const why = (id: string) => view.loads.find((l) => l.id === id)!.reason;
  assert.equal(why(ok.id), null);
  assert.equal(why(noPacket.id), "no_packet");
  assert.equal(why(draft.id), "packet_not_submitted");
  assert.equal(why(paid.id), "already_paid");
  assert.equal(why(early.id), "not_delivered");
  for (const id of [noPacket.id, draft.id, paid.id, early.id])
    await assert.rejects(batch([id]), { code: "LOAD_NOT_ELIGIBLE" });
  // A load of another carrier is indistinguishable from one that does not exist.
  const foreign = await bookedLoad(t.dispatcher, t.foreign);
  await assert.rejects(batch([ok.id, foreign.id]), { code: "NOT_FOUND" });
  await assert.rejects(batch([randomUUID()]), { code: "NOT_FOUND" });

  const key = randomUUID();
  const made = await batch([ok.id], key);
  assert.deepEqual(await batch([ok.id], key), made); // replay
  await assert.rejects(batch([ok.id, paid.id], key), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  const file = await batchFile(t.manager, made.id);
  const lines = file.csv.trimEnd().split("\r\n");
  assert.equal(
    lines[0],
    "carrier_invoice_number,load_reference,bill_to,amount,currency,delivered_on,invoice_submitted_on,documents",
  );
  assert.equal(lines.length, 2);
  // Money as exact decimal text; a formula in a cell is neutralised.
  assert.match(lines[1], /,2500\.00,USD,/);
  assert.match(lines[1], /"'=HYPERLINK\(""http:\/\/evil\.test""\)"/);
  assert.equal(
    createHash("sha256").update(file.csv).digest("hex"),
    file.sha256,
  );
  const row = (
    await pool.query(
      "SELECT status,load_count,total_minor::text,payout_change_id FROM factoring_batches WHERE id=$1",
      [made.id],
    )
  ).rows[0];
  assert.deepEqual(
    [
      row.status,
      row.load_count,
      row.total_minor,
      row.payout_change_id !== null,
    ],
    ["prepared", 1, "250000", true],
  );

  // A load is in one batch at a time; voiding releases it; a handed-off batch can still be voided.
  assert.equal(
    (await factoringOverview(t.dispatcher, t.carrier)).loads.find(
      (l) => l.id === ok.id,
    )!.reason,
    "already_in_batch",
  );
  await assert.rejects(batch([ok.id]), { code: "LOAD_NOT_ELIGIBLE" });
  await markHandedOff(t.manager, made.id, { version: 1 });
  await assert.rejects(markHandedOff(t.manager, made.id, { version: 2 }), {
    code: "BATCH_NOT_PREPARED",
  });
  await assert.rejects(
    voidBatch(t.manager, made.id, { version: 1, reason: "x" }),
    { code: "VERSION_CONFLICT" },
  );
  // Cancelling after handoff needs the carrier to say the factor was told...
  await assert.rejects(
    voidBatch(t.manager, made.id, { version: 2, reason: "Factor rejected it" }),
    { code: "FACTOR_NOTICE_REQUIRED" },
  );
  const voided = await voidBatch(t.manager, made.id, {
    version: 2,
    reason: "Factor rejected the schedule",
    factor_informed: true,
  });
  assert.equal(voided.loads_held, true);
  await assert.rejects(
    voidBatch(t.manager, made.id, { version: 3, reason: "again" }),
    { code: "BATCH_VOID" },
  );
  // ...and its loads stay held: they may already have been advanced against, so
  // they cannot go straight into a new schedule.
  const overview = await factoringOverview(t.dispatcher, t.carrier);
  assert.equal(
    overview.loads.find((l) => l.id === ok.id)!.reason,
    "held_after_handoff",
  );
  assert.equal(
    overview.batches.find((x) => x.id === made.id)!.loads_held,
    true,
  );
  await assert.rejects(batch([ok.id]), { code: "LOAD_NOT_ELIGIBLE" });
  // Releasing them needs the factor's confirmation, once.
  await assert.rejects(
    releaseBatchLoads(t.manager, made.id, {
      version: 3,
      factor_confirmed_no_advance: false,
    }),
    { name: "ZodError" },
  );
  await assert.rejects(
    releaseBatchLoads(t.manager, made.id, {
      version: 2,
      factor_confirmed_no_advance: true,
    }),
    { code: "VERSION_CONFLICT" },
  );
  await releaseBatchLoads(t.manager, made.id, {
    version: 3,
    factor_confirmed_no_advance: true,
  });
  await assert.rejects(
    releaseBatchLoads(t.manager, made.id, {
      version: 4,
      factor_confirmed_no_advance: true,
    }),
    { code: "BATCH_NOT_HELD" },
  );
  assert.equal(
    (await factoringOverview(t.dispatcher, t.carrier)).loads.find(
      (l) => l.id === ok.id,
    )!.reason,
    null,
  );
  // A schedule that was never handed over frees its loads at once.
  const fresh = await billed();
  const prepared = await batch([fresh.id]);
  const freed = await voidBatch(t.manager, prepared.id, {
    version: 1,
    reason: "Wrong loads",
  });
  assert.equal(freed.loads_held, false);
  assert.equal(
    (await factoringOverview(t.dispatcher, t.carrier)).loads.find(
      (l) => l.id === fresh.id,
    )!.reason,
    null,
  );
  await assert.rejects(
    releaseBatchLoads(t.manager, prepared.id, {
      version: 2,
      factor_confirmed_no_advance: true,
    }),
    { code: "BATCH_NOT_HELD" },
  );
  const again = await batch([ok.id]);
  assert.notEqual(again.id, made.id);
  // The batch actions are audited with the carrier's people as actors.
  const actions = (
    await pool.query("SELECT action FROM audit_logs WHERE resource_id=$1", [
      t.carrier,
    ])
  ).rows.map((r) => r.action);
  for (const a of [
    "factoring.enabled",
    "factoring.batch_prepared",
    "factoring.batch_downloaded",
    "factoring.batch_handed_off",
    "factoring.batch_voided",
    "factoring.batch_released",
  ])
    assert.ok(actions.includes(a), a);
});

test("HTTP: the schedule file and every action are for the carrier's own people only", async () => {
  await enable();
  const ok = await billed();
  const made = await batch([ok.id]);
  const call = async (
    method: "GET" | "POST",
    path: string,
    user: string,
    json?: unknown,
  ) => {
    const req = request(path, {
      method,
      token: await sessionFor(user),
      ...(json ? { json } : {}),
    });
    return await (method === "GET" ? GET(req) : POST(req));
  };
  const file = await call(
    "GET",
    `factoring/batches/${made.id}/file`,
    t.manager,
  );
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type")!, /^text\/csv/);
  assert.match(file.headers.get("x-file-sha256")!, /^[0-9a-f]{64}$/);
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  const reads = [
    `factoring?carrier_id=${t.carrier}`,
    `factoring/batches/${made.id}/file`,
  ];
  const writes: [string, unknown][] = [
    [
      "factoring/settings",
      { carrier_id: t.carrier, enabled: false, factor_name: "" },
    ],
    [
      "factoring/batches",
      { carrier_id: t.carrier, load_ids: [ok.id], key: randomUUID() },
    ],
    [`factoring/batches/${made.id}/handoff`, { version: 1 }],
    [`factoring/batches/${made.id}/void`, { version: 1, reason: "x" }],
    [
      `factoring/batches/${made.id}/release`,
      { version: 1, factor_confirmed_no_advance: true },
    ],
  ];
  for (const user of [t.driverUser, t.foreignManager]) {
    for (const p of reads)
      assert.equal((await call("GET", p, user)).status, 404, p);
    for (const [p, body] of writes)
      assert.equal((await call("POST", p, user, body)).status, 404, p);
  }
  assert.equal((await call("GET", "factoring", t.manager)).status, 400);
  assert.equal(
    (
      await call("POST", "factoring/batches", t.manager, {
        carrier_id: t.carrier,
        load_ids: [],
        key: randomUUID(),
      })
    ).status,
    400,
  );
});

test("an old load that is ready is listed however long the history, and a cut list says so", async () => {
  const fresh = await billed();
  const newer: string[] = [];
  for (let i = 0; i < 3; i++)
    newer.push((await billed("Newer " + i, false, false)).id);
  await enable();
  await payout("0");
  // Only the newest 2 loads of the history are read for "why not"; the old ready one is still found.
  const view = await factoringOverview(t.dispatcher, t.carrier, {
    recentLimit: 2,
  });
  const found = view.loads.find((l) => l.id === fresh.id);
  assert.ok(found && found.eligible);
  assert.equal(view.ready_truncated, false);
  // The newest loads are still explained.
  assert.ok(
    view.loads.some((l) => l.id === newer[2] && l.reason === "no_packet"),
  );
  // A ceiling on ready loads is reported.
  const capped = await factoringOverview(t.dispatcher, t.carrier, {
    readyLimit: 1,
    recentLimit: 2,
  });
  assert.equal(capped.ready_truncated, true);
  assert.equal(capped.loads.filter((l) => l.eligible).length, 1);
});
