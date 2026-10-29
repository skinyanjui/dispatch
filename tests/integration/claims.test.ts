import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  claimPacket,
  createClaim,
  listClaims,
  loadClaims,
  refreshClaim,
  setTerms,
  settleClaim,
  submitClaim,
} from "../../src/lib/claims";
import {
  detentionCalc,
  tonuEligibility,
} from "../../src/lib/accessorial-rules";
import { cancelLoad } from "../../src/lib/load-changes";
import {
  createLoad,
  detail,
  mutate,
  recordStopEvent,
} from "../../src/lib/loads";
import type { Load } from "../../src/lib/contracts";
import { reviewDocument, uploadDocument } from "../../src/lib/documents";
import { pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Claims");
});
after(() => pool.end());

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();

/** A load whose pickup window closed 10 hours ago (opened 11 hours ago). */
async function route() {
  const load = await createLoad(
    t.dispatcher,
    {
      carrierId: t.carrier,
      reference: "CLM-" + randomUUID().slice(0, 8),
      source: "Fictional claims QA",
      amountMinor: 300000,
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: ago(660),
          windowEnd: ago(600),
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: ago(300),
          windowEnd: ago(240),
        },
      ],
    },
    randomUUID(),
  );
  const version = (
    await mutate(t.dispatcher, load.id, "assign", {
      version: 1,
      driverId: t.driver,
    })
  ).version;
  const view = (await detail(t.dispatcher, load.id)) as Load;
  return { load, version, stops: view.stops!.map((s) => s.id!) };
}
const report = (
  version: number,
  kind: "arrived" | "departed",
  occurred_at: string,
  extra: Record<string, unknown> = {},
) => ({
  version,
  kind,
  occurred_at,
  idempotency_key: randomUUID(),
  ...extra,
});
/** Upload a rate confirmation for the load and accept it. */
async function acceptRateConfirmation(loadId: string) {
  const v = await uploadDocument(
    t.dispatcher,
    {
      carrier_id: t.carrier,
      load_id: loadId,
      type: "rate_confirmation",
      idempotency_key: randomUUID(),
    },
    { name: "rate-confirmation.pdf", bytes: pdf() },
  );
  await reviewDocument(t.dispatcher, v.version_id, { decision: "accepted" });
  return v.version_id as string;
}
const terms = async (
  loadId: string,
  version = 0,
  over: Record<string, unknown> = {},
) => {
  if ((over.source ?? "rate_confirmation") === "rate_confirmation") {
    const has = await pool.query(
      "SELECT 1 FROM documents WHERE load_id=$1 AND type='rate_confirmation'",
      [loadId],
    );
    if (!has.rowCount) await acceptRateConfirmation(loadId);
  }
  return setTerms(t.dispatcher, {
    load_id: loadId,
    free_minutes: 120,
    rate_minor_per_hour: 6000,
    cap_minutes: null,
    tonu_minor: 15000,
    source: "rate_confirmation",
    version,
    ...over,
  });
};
/** Arrives 30 minutes into the window, leaves four hours later: 240 minutes on site. */
async function visit(r: Awaited<ReturnType<typeof route>>) {
  let version = r.version;
  version = (
    await recordStopEvent(
      t.driverUser,
      r.load.id,
      r.stops[0],
      report(version, "arrived", ago(630)),
    )
  ).version;
  version = (
    await recordStopEvent(
      t.driverUser,
      r.load.id,
      r.stops[0],
      report(version, "departed", ago(390)),
    )
  ).version;
  return version;
}

test("detention arithmetic: later of arrival and window opening, free time, cap, half-up pro rata", () => {
  const rep = (occurred_at: string, late = 0) => ({
    occurred_at,
    recorded_at: new Date(Date.parse(occurred_at) + late * 60000).toISOString(),
  });
  const base = {
    terms: {
      free_minutes: 120,
      rate_minor_per_hour: "6000",
      cap_minutes: null,
    },
    window_start: "2026-10-01T14:00:00.000Z",
    window_end: "2026-10-01T15:00:00.000Z",
    arrived: rep("2026-10-01T14:30:00.000Z"),
    departed: rep("2026-10-01T18:30:00.000Z"),
    corrected: false,
  };
  const c = detentionCalc(base);
  assert.deepEqual(
    [c.complete, c.dwell_minutes, c.billable_minutes, c.amount_minor, c.issues],
    [true, 240, 120, "12000", []],
  );
  // Early arrival: the clock starts when the window opens.
  const early = detentionCalc({
    ...base,
    arrived: rep("2026-10-01T12:00:00.000Z"),
  });
  assert.deepEqual(
    [early.clock_start, early.dwell_minutes, early.billable_minutes],
    ["2026-10-01T14:00:00.000Z", 270, 150],
  );
  // Cap, and rounding of $50 per hour for 100 minutes: 8333.33 cents rounds down; 150 minutes at $1.01/hr rounds up.
  const capped = detentionCalc({
    ...base,
    terms: { ...base.terms, cap_minutes: 90 },
  });
  assert.deepEqual(
    [capped.billable_minutes, capped.capped, capped.amount_minor],
    [90, true, "9000"],
  );
  assert.equal(
    detentionCalc({
      ...base,
      terms: {
        free_minutes: 140,
        rate_minor_per_hour: "5000",
        cap_minutes: null,
      },
    }).amount_minor,
    "8333",
  );
  assert.equal(
    detentionCalc({
      ...base,
      terms: {
        free_minutes: 90,
        rate_minor_per_hour: "101",
        cap_minutes: null,
      },
    }).amount_minor,
    "253",
  ); // 150 min × 101/60 = 252.5
  // Inside free time: nothing.
  assert.equal(
    detentionCalc({ ...base, departed: rep("2026-10-01T15:00:00.000Z") })
      .amount_minor,
    "0",
  );
  // Issues are named, never hidden.
  assert.deepEqual(detentionCalc({ ...base, terms: null }).issues, [
    "no_terms",
  ]);
  assert.deepEqual(detentionCalc({ ...base, departed: null }).issues, [
    "not_departed",
  ]);
  assert.equal(detentionCalc({ ...base, departed: null }).complete, false);
  assert.ok(
    detentionCalc({
      ...base,
      arrived: rep("2026-10-01T16:00:00.000Z"),
    }).issues.includes("arrived_after_window"),
  );
  assert.ok(
    detentionCalc({ ...base, corrected: true }).issues.includes(
      "times_were_corrected",
    ),
  );
  assert.ok(
    detentionCalc({
      ...base,
      arrived: rep("2026-10-01T14:30:00.000Z", 3000),
    }).issues.includes("recorded_late"),
  );
  assert.deepEqual(
    tonuEligibility({ cancelled: true, stage: "dispatched", party: "payer" }),
    { eligible: true, reason: null },
  );
  // Only the payer's cancellation is owed; anyone else's, or an unrecorded one, is not.
  for (const party of ["carrier", "dispatch", "other", null])
    assert.equal(
      tonuEligibility({ cancelled: true, stage: "dispatched", party }).eligible,
      false,
      String(party),
    );
  assert.equal(
    tonuEligibility({ cancelled: true, stage: "booked" }).eligible,
    false,
  );
  assert.equal(
    tonuEligibility({ cancelled: false, stage: "dispatched" }).eligible,
    false,
  );
});

test("a detention claim freezes its evidence, can be refreshed while a draft, sent, and settled", async () => {
  const r = await route();
  // No terms and no times yet.
  await assert.rejects(
    createClaim(t.dispatcher, {
      load_id: r.load.id,
      kind: "detention",
      stop_id: r.stops[0],
      key: randomUUID(),
    }),
    { code: "TERMS_REQUIRED" },
  );
  await terms(r.load.id);
  await assert.rejects(
    createClaim(t.dispatcher, {
      load_id: r.load.id,
      kind: "detention",
      stop_id: r.stops[0],
      key: randomUUID(),
    }),
    { code: "EVIDENCE_INCOMPLETE" },
  );
  const version = await visit(r);
  const view = await loadClaims(t.manager, r.load.id);
  assert.equal(view.detention[0].calc.billable_minutes, 120);
  assert.equal(view.detention[0].calc.amount_minor, "12000");

  const key = randomUUID();
  const input = {
    load_id: r.load.id,
    kind: "detention",
    stop_id: r.stops[0],
    note: "Dock was backed up",
    key,
  };
  const made = await createClaim(t.dispatcher, input);
  assert.deepEqual(await createClaim(t.dispatcher, input), made); // idempotent
  await assert.rejects(
    createClaim(t.dispatcher, { ...input, note: "different" }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    createClaim(t.dispatcher, { ...input, key: randomUUID() }),
    { code: "CLAIM_OPEN" },
  );
  // Terms do not move under an open claim.
  await assert.rejects(terms(r.load.id, 1, { free_minutes: 60 }), {
    code: "CLAIM_OPEN",
  });

  let claim = (await loadClaims(t.dispatcher, r.load.id)).claims[0];
  assert.equal(claim.status, "draft");
  assert.equal(claim.claimed_minor, "12000");
  const ev = claim.evidence as {
    events: { kind: string; recorded_by: string; source: string }[];
    calc: { issues: string[] };
  };
  assert.equal(ev.events.length, 2);
  assert.ok(
    ev.events.every(
      (e) => e.source === "manual" && e.recorded_by.includes("Driver"),
    ),
  );

  // A corrected departure changes the draft only when refreshed; the correction is flagged.
  const stop = ((await detail(t.dispatcher, r.load.id)) as Load)
    .stops![0] as unknown as { departed: { id: string } };
  await recordStopEvent(
    t.dispatcher,
    r.load.id,
    r.stops[0],
    report(
      (await detail(t.dispatcher, r.load.id)).version,
      "departed",
      ago(420),
      { supersedes: stop.departed.id, reason: "Driver misread the clock" },
    ),
  );
  assert.equal(
    (await loadClaims(t.dispatcher, r.load.id)).claims[0].claimed_minor,
    "12000",
  );
  const refreshed = await refreshClaim(t.dispatcher, made.id, {
    version: made.version,
  });
  claim = (await loadClaims(t.dispatcher, r.load.id)).claims[0];
  assert.equal(refreshed.version, 2);
  assert.equal(claim.claimed_minor, "9000"); // 210 minutes on site, 90 billable
  assert.ok(
    (claim.evidence as typeof ev).calc.issues.includes("times_were_corrected"),
  );
  await assert.rejects(
    refreshClaim(t.dispatcher, made.id, { version: made.version }),
    { code: "VERSION_CONFLICT" },
  );

  // The packet is a PDF with the arithmetic and who recorded what.
  const packet = await claimPacket(t.manager, made.id);
  const text = packet.bytes.toString("latin1").replace(/\) Tj T\* \(/g, " ");
  assert.ok(text.startsWith("%PDF"));
  assert.match(text, /DRAFT - not yet sent/);
  assert.match(text, /Billable: 90 min/);
  assert.match(text, /corrects an earlier report: Driver misread the clock/);

  await submitClaim(t.manager, made.id, { version: 2 });
  await assert.rejects(refreshClaim(t.dispatcher, made.id, { version: 3 }), {
    code: "CLAIM_NOT_DRAFT",
  });
  await assert.rejects(submitClaim(t.dispatcher, made.id, { version: 3 }), {
    code: "CLAIM_NOT_DRAFT",
  });
  await assert.rejects(
    settleClaim(t.manager, made.id, { version: 3, outcome: "paid" }),
    { code: "AMOUNT_REQUIRED" },
  );
  await assert.rejects(
    settleClaim(t.manager, made.id, {
      version: 3,
      outcome: "paid",
      settled_minor: 9001,
    }),
    { code: "OVER_CLAIMED" },
  );
  await assert.rejects(
    settleClaim(t.manager, made.id, {
      version: 3,
      outcome: "denied",
      settled_minor: 1,
    }),
    { code: "VALIDATION_ERROR" },
  );
  await settleClaim(t.manager, made.id, {
    version: 3,
    outcome: "paid",
    settled_minor: 7500,
    note: "Paid short",
  });
  const list = await listClaims(t.dispatcher, t.carrier);
  const mine = list.claims.find((c) => c.id === made.id)!;
  assert.deepEqual(
    [mine.status, mine.claimed_minor, mine.settled_minor],
    ["paid", "9000", "7500"],
  );
  assert.equal(BigInt(list.totals.paid_minor) >= 7500n, true);
  await assert.rejects(
    settleClaim(t.manager, made.id, { version: 4, outcome: "denied" }),
    { code: "CLAIM_NOT_SUBMITTED" },
  );
  void version;
  // Once settled the slot is free; a denied claim can be raised again after terms change.
  const again = await createClaim(t.dispatcher, {
    load_id: r.load.id,
    kind: "detention",
    stop_id: r.stops[0],
    key: randomUUID(),
  });
  await submitClaim(t.dispatcher, again.id, { version: 1 });
  await settleClaim(t.dispatcher, again.id, {
    version: 2,
    outcome: "denied",
    note: "Outside terms",
  });
  const denied = (await loadClaims(t.dispatcher, r.load.id)).claims.find(
    (c) => c.id === again.id,
  )!;
  assert.deepEqual([denied.status, denied.settled_minor], ["denied", null]);
});

test("TONU needs a cancellation after dispatch, a stated fee and terms; the evidence names who and when", async () => {
  const r = await route();
  const key = () => randomUUID();
  await terms(r.load.id, 0, { tonu_minor: null });
  await assert.rejects(
    createClaim(t.dispatcher, { load_id: r.load.id, kind: "tonu", key: key() }),
    { code: "TONU_NOT_ELIGIBLE" },
  );
  let version = (
    await mutate(t.dispatcher, r.load.id, "milestones", {
      version: r.version,
      stage: "dispatched",
    })
  ).version;
  // Once dispatched, a cancellation must say who made it.
  await assert.rejects(
    cancelLoad(t.dispatcher, r.load.id, {
      version,
      reason: "Shipper cancelled the order",
    }),
    { code: "CANCEL_PARTY_REQUIRED" },
  );
  await cancelLoad(t.dispatcher, r.load.id, {
    version,
    reason: "Shipper cancelled the order",
    party: "payer",
  });
  assert.equal((await loadClaims(t.manager, r.load.id)).tonu.eligible, true);
  await assert.rejects(
    createClaim(t.dispatcher, { load_id: r.load.id, kind: "tonu", key: key() }),
    { code: "TONU_AMOUNT_REQUIRED" },
  );
  await terms(r.load.id, 1, { tonu_minor: 15000 });
  // A fee agreed only by phone is not claimed.
  await terms(r.load.id, 2, { tonu_minor: 15000, source: "verbal" });
  await assert.rejects(
    createClaim(t.dispatcher, { load_id: r.load.id, kind: "tonu", key: key() }),
    { code: "TONU_TERMS_NOT_WRITTEN" },
  );
  await terms(r.load.id, 3, { tonu_minor: 15000 });
  const made = await createClaim(t.dispatcher, {
    load_id: r.load.id,
    kind: "tonu",
    key: key(),
  });
  const claim = (await loadClaims(t.dispatcher, r.load.id)).claims[0];
  assert.equal(claim.claimed_minor, "15000");
  const tonu = (claim.evidence as { tonu: Record<string, string | null> }).tonu;
  assert.equal(tonu.cancel_reason, "Shipper cancelled the order");
  assert.equal(tonu.cancelled_by_party, "payer");
  assert.ok(
    tonu.dispatched_at && tonu.cancelled_at && tonu.cancelled_by && tonu.driver,
  );
  assert.match(
    (await claimPacket(t.dispatcher, made.id)).bytes.toString("latin1"),
    /Truck ordered not used/,
  );
  // The carrier's own cancellation never qualifies, whatever it says in the reason.
  const own = await route();
  await terms(own.load.id);
  const ownVersion = (
    await mutate(t.dispatcher, own.load.id, "milestones", {
      version: own.version,
      stage: "dispatched",
    })
  ).version;
  await cancelLoad(t.manager, own.load.id, {
    version: ownVersion,
    reason: "Our truck broke down",
    party: "carrier",
  });
  const ownView = await loadClaims(t.manager, own.load.id);
  assert.equal(ownView.tonu.eligible, false);
  assert.match(ownView.tonu.reason!, /made by the carrier/);
  await assert.rejects(
    createClaim(t.manager, { load_id: own.load.id, kind: "tonu", key: key() }),
    { code: "TONU_NOT_ELIGIBLE" },
  );
  // Cancelled while still booked does not qualify.
  const early = await route();
  await terms(early.load.id);
  await cancelLoad(t.dispatcher, early.load.id, {
    version: early.version,
    reason: "Never dispatched",
  });
  await assert.rejects(
    createClaim(t.dispatcher, {
      load_id: early.load.id,
      kind: "tonu",
      key: key(),
    }),
    { code: "TONU_NOT_ELIGIBLE" },
  );
});

test("HTTP: only people of the carrier can read or change claims; strangers and drivers get 404", async () => {
  const r = await route();
  await terms(r.load.id);
  await visit(r);
  const made = await createClaim(t.dispatcher, {
    load_id: r.load.id,
    kind: "detention",
    stop_id: r.stops[0],
    key: randomUUID(),
  });
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
    return (await (method === "GET" ? GET(req) : POST(req))).status;
  };
  const reads = [
    "claims?carrier_id=" + t.carrier,
    "claims/load?load_id=" + r.load.id,
    `claims/${made.id}/packet`,
  ];
  const writes: [string, unknown][] = [
    ["claims", { load_id: r.load.id, kind: "tonu", key: randomUUID() }],
    [
      "claims/terms",
      {
        load_id: r.load.id,
        free_minutes: 1,
        rate_minor_per_hour: 1,
        cap_minutes: null,
        tonu_minor: null,
        source: "verbal",
        version: 1,
      },
    ],
    [`claims/${made.id}/refresh`, { version: 1 }],
    [`claims/${made.id}/submit`, { version: 1 }],
    [`claims/${made.id}/outcome`, { version: 1, outcome: "denied" }],
  ];
  for (const user of [t.driverUser, t.foreignManager]) {
    for (const p of reads) assert.equal(await call("GET", p, user), 404, p);
    for (const [p, body] of writes)
      assert.equal(await call("POST", p, user, body), 404, p);
  }
  for (const p of reads) assert.equal(await call("GET", p, t.manager), 200, p);
  assert.equal(
    await call("POST", `claims/${made.id}/refresh`, t.manager, {
      version: 1,
      extra: true,
    }),
    400,
  );
  assert.equal(
    await call("POST", "claims", t.manager, {
      load_id: r.load.id,
      kind: "detention",
    }),
    400,
  );
});

test("terms taken from the rate confirmation point at that accepted file; without one they are refused", async () => {
  const r = await route();
  await assert.rejects(
    setTerms(t.dispatcher, {
      load_id: r.load.id,
      free_minutes: 120,
      rate_minor_per_hour: 6000,
      cap_minutes: null,
      tonu_minor: null,
      source: "rate_confirmation",
      version: 0,
    }),
    { message: "RATE_CONFIRMATION_REQUIRED" },
  );
  // A written agreement does not need the file.
  await terms(r.load.id, 0, { source: "agreement" });
  const versionId = await acceptRateConfirmation(r.load.id);
  await terms(r.load.id, 1);
  const claims = await loadClaims(t.dispatcher, r.load.id);
  assert.equal(claims.terms?.source_document?.version_id, versionId);
  assert.equal(
    claims.terms?.source_document?.filename,
    "rate-confirmation.pdf",
  );
});
