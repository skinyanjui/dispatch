import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { member, scoped, stopsWithEvents } from "./loads";
import { emit } from "./onboarding";
import { textPdf } from "./simple-pdf";
import {
  detentionCalc,
  tonuEligibility,
  type DetentionTerms,
} from "./accessorial-rules";

/**
 * Detention and TONU claims with the evidence behind them (ADR 0067). Terms
 * come from the rate confirmation or agreement; a claim freezes the stop times
 * (with who recorded each and when), the terms and the arithmetic it was made
 * from, then moves draft, submitted, paid or denied. Relay prepares the packet;
 * the carrier sends it and reports the outcome. Money is integer minor units.
 */
const key = z.uuid();
const money = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const termsSchema = z
  .object({
    load_id: z.uuid(),
    free_minutes: z.number().int().min(0).max(1440),
    rate_minor_per_hour: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cap_minutes: z.number().int().min(1).max(4320).nullable(),
    tonu_minor: money.nullable(),
    source: z.enum(["rate_confirmation", "agreement", "verbal"]),
    version: z.number().int().min(0),
  })
  .strict();
export const createSchema = z
  .object({
    load_id: z.uuid(),
    kind: z.enum(["detention", "tonu"]),
    stop_id: z.uuid().optional(),
    note: z.string().trim().max(500).default(""),
    key,
  })
  .strict();
const versionOnly = z.object({ version: z.number().int().positive() }).strict();
const outcomeSchema = z
  .object({
    version: z.number().int().positive(),
    outcome: z.enum(["paid", "denied"]),
    settled_minor: money.optional(),
    note: z.string().trim().max(500).default(""),
  })
  .strict();

type Terms = {
  free_minutes: number;
  rate_minor_per_hour: string;
  cap_minutes: number | null;
  tonu_minor: string | null;
  source: string;
  version: number;
  set_at: string;
};

async function loadTerms(c: PoolClient | typeof pool, loadId: string) {
  const r = await c.query(
    `SELECT free_minutes,rate_minor_per_hour::text,cap_minutes,tonu_minor::text,source,version,set_at
     FROM detention_terms WHERE load_id=$1`,
    [loadId],
  );
  const row = r.rows[0];
  return row
    ? ({ ...row, set_at: new Date(row.set_at).toISOString() } as Terms)
    : null;
}
const toRules = (t: Terms | null): DetentionTerms | null =>
  t && {
    free_minutes: t.free_minutes,
    rate_minor_per_hour: t.rate_minor_per_hour,
    cap_minutes: t.cap_minutes,
  };

const iso = (v: unknown) => new Date(v as string).toISOString();

/** What the evidence for one stop looks like right now. */
async function stopEvidence(
  c: PoolClient,
  load: { id: string },
  stopId: string,
  terms: Terms | null,
) {
  const stops = await stopsWithEvents(c, load.id);
  const stop = stops.find((s) => s.id === stopId);
  if (!stop) throw new HttpError(404, "NOT_FOUND");
  const events = (stop.stop_events ?? []).map((e) => ({
    id: e.id,
    kind: e.kind,
    occurred_at: iso(e.occurred_at),
    recorded_at: iso(e.recorded_at),
    recorded_by: e.actor_name,
    source: "manual",
    note: e.note,
    supersedes: e.supersedes,
    reason: e.reason,
  }));
  const report = (
    e: { occurred_at: string; recorded_at: string } | null | undefined,
  ) =>
    e
      ? { occurred_at: iso(e.occurred_at), recorded_at: iso(e.recorded_at) }
      : null;
  const calc = detentionCalc({
    terms: toRules(terms),
    window_start: iso(stop.window_start),
    window_end: iso(stop.window_end),
    arrived: report(stop.arrived),
    departed: report(stop.departed),
    corrected: events.some((e) => e.supersedes !== null),
  });
  return {
    stop: {
      id: stop.id as string,
      sequence: (stop as unknown as { sequence: number }).sequence,
      kind: stop.kind,
      address: stop.address,
      timezone: stop.timezone,
      window_start: iso(stop.window_start),
      window_end: iso(stop.window_end),
    },
    events,
    calc,
  };
}

async function tonuEvidence(c: PoolClient, load: Record<string, unknown>) {
  const who = await c.query(`SELECT u.name FROM users u WHERE u.id=$1`, [
    load.cancelled_by,
  ]);
  const dispatched = await c.query(
    `SELECT e.created_at,u.name FROM load_events e JOIN users u ON u.id=e.actor_id
     WHERE e.load_id=$1 AND e.type='load.milestones' AND e.payload->>'stage'='dispatched' ORDER BY e.created_at LIMIT 1`,
    [load.id],
  );
  const driver = await c.query(
    `SELECT d.name FROM load_assignments a JOIN drivers d ON d.id=a.driver_id WHERE a.load_id=$1`,
    [load.id],
  );
  return {
    cancelled_at: load.cancelled_at ? iso(load.cancelled_at) : null,
    cancelled_by: (who.rows[0]?.name as string | undefined) ?? null,
    cancel_reason: (load.cancel_reason as string | null) ?? null,
    dispatched_at: dispatched.rows[0]
      ? iso(dispatched.rows[0].created_at)
      : null,
    dispatched_by: (dispatched.rows[0]?.name as string | undefined) ?? null,
    driver: (driver.rows[0]?.name as string | undefined) ?? null,
  };
}

const claimView = (r: Record<string, unknown>) => ({
  id: r.id as string,
  load_id: r.load_id as string,
  load_reference: r.reference as string,
  kind: r.kind as "detention" | "tonu",
  stop_id: (r.stop_id as string | null) ?? null,
  status: r.status as "draft" | "submitted" | "paid" | "denied",
  claimed_minor: r.claimed_minor as string,
  settled_minor: (r.settled_minor as string | null) ?? null,
  note: r.note as string,
  outcome_note: r.outcome_note as string,
  created_at: iso(r.created_at),
  submitted_at: r.submitted_at ? iso(r.submitted_at) : null,
  settled_at: r.settled_at ? iso(r.settled_at) : null,
  version: r.version as number,
  evidence: r.evidence,
});

const claimSql = `SELECT a.id,a.load_id,l.reference,a.kind,a.stop_id,a.status,a.claimed_minor::text,a.settled_minor::text,
  a.note,a.outcome_note,a.created_at,a.submitted_at,a.settled_at,a.version,a.evidence
  FROM accessorial_claims a JOIN loads l ON l.id=a.load_id`;

/** Terms, per-stop detention arithmetic, TONU eligibility and claims for one load. */
export async function loadClaims(user: string, loadId: string) {
  return transaction(async (c) => {
    const load = await scoped(c, user, loadId, false, false, true);
    await member(c, user, load.carrier_id, true);
    const terms = await loadTerms(c, loadId);
    const stops = await c.query(
      "SELECT id FROM load_stops WHERE load_id=$1 ORDER BY sequence",
      [loadId],
    );
    const detention = [];
    for (const s of stops.rows)
      detention.push(await stopEvidence(c, load, s.id, terms));
    const claims = await c.query(
      `${claimSql} WHERE a.load_id=$1 ORDER BY a.created_at DESC,a.id`,
      [loadId],
    );
    const tonu = tonuEligibility({
      cancelled: !!load.cancelled_at,
      stage: load.stage,
    });
    return {
      load_id: loadId,
      terms,
      detention,
      tonu: { ...tonu, amount_minor: terms?.tonu_minor ?? null },
      claims: claims.rows.map(claimView),
    };
  });
}

/** Claims across a carrier, newest first. */
export async function listClaims(user: string, carrierId: string) {
  return transaction(async (c) => {
    await member(c, user, carrierId, true);
    const rows = await c.query(
      `${claimSql} WHERE a.carrier_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 200`,
      [carrierId],
    );
    const sum = (status: string) =>
      rows.rows
        .filter((r) => r.status === status)
        .reduce((t, r) => t + BigInt(r.claimed_minor), 0n)
        .toString();
    return {
      carrier_id: carrierId,
      claims: rows.rows.map((r) => ({ ...claimView(r), evidence: undefined })),
      totals: {
        draft_minor: sum("draft"),
        submitted_minor: sum("submitted"),
        paid_minor: rows.rows
          .filter((r) => r.status === "paid")
          .reduce((t, r) => t + BigInt(r.settled_minor), 0n)
          .toString(),
      },
    };
  });
}

/** Sets what the rate confirmation or agreement says about free time, rate and TONU. */
export async function setTerms(user: string, input: unknown) {
  const data = termsSchema.parse(input);
  return transaction(async (c) => {
    const load = await scoped(c, user, data.load_id, true, false, true);
    await member(c, user, load.carrier_id, true);
    const old = await loadTerms(c, data.load_id);
    if ((old?.version ?? 0) !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    const open = await c.query(
      "SELECT 1 FROM accessorial_claims WHERE load_id=$1 AND status IN ('draft','submitted') LIMIT 1",
      [data.load_id],
    );
    // Terms a submitted claim relies on do not change under it.
    if (open.rowCount) throw new HttpError(409, "CLAIM_OPEN");
    await c.query(
      `INSERT INTO detention_terms(load_id,carrier_id,free_minutes,rate_minor_per_hour,cap_minutes,tonu_minor,source,set_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(load_id) DO UPDATE SET free_minutes=$3,rate_minor_per_hour=$4,cap_minutes=$5,tonu_minor=$6,source=$7,
         set_by=$8,set_at=now(),version=detention_terms.version+1`,
      [
        data.load_id,
        load.carrier_id,
        data.free_minutes,
        data.rate_minor_per_hour,
        data.cap_minutes,
        data.tonu_minor,
        data.source,
        user,
      ],
    );
    await emit(c, user, load.carrier_id, "claim.terms_set", {
      load_id: data.load_id,
      source: data.source,
    });
    return { load_id: data.load_id, version: data.version + 1 };
  });
}

async function snapshot(
  c: PoolClient,
  load: Record<string, unknown>,
  kind: "detention" | "tonu",
  stopId: string | undefined,
  terms: Terms | null,
) {
  if (!terms) throw new HttpError(422, "TERMS_REQUIRED");
  if (kind === "detention") {
    if (!stopId) throw new HttpError(422, "STOP_REQUIRED");
    const e = await stopEvidence(c, load as { id: string }, stopId, terms);
    if (!e.calc.complete) throw new HttpError(422, "EVIDENCE_INCOMPLETE");
    if (BigInt(e.calc.amount_minor) <= 0n)
      throw new HttpError(422, "NOTHING_TO_CLAIM");
    return {
      claimed: e.calc.amount_minor,
      evidence: {
        kind,
        captured_at: new Date().toISOString(),
        load: { id: load.id, reference: load.reference },
        terms,
        stop: e.stop,
        events: e.events,
        calc: e.calc,
      },
    };
  }
  const eligible = tonuEligibility({
    cancelled: !!load.cancelled_at,
    stage: load.stage as string,
  });
  if (!eligible.eligible) throw new HttpError(422, "TONU_NOT_ELIGIBLE");
  if (!terms.tonu_minor) throw new HttpError(422, "TONU_AMOUNT_REQUIRED");
  return {
    claimed: terms.tonu_minor,
    evidence: {
      kind,
      captured_at: new Date().toISOString(),
      load: { id: load.id, reference: load.reference },
      terms,
      tonu: await tonuEvidence(c, load),
    },
  };
}

/** Starts a draft claim from the evidence as it stands now. */
export async function createClaim(user: string, input: unknown) {
  const data = createSchema.parse(input);
  const hash = digest(JSON.stringify(data));
  return transaction(async (c) => {
    const load = await scoped(c, user, data.load_id, true, false, true);
    await member(c, user, load.carrier_id, true);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":claim:" + data.key,
    ]);
    const old = await c.query(
      "SELECT id,request_hash,version FROM accessorial_claims WHERE created_by=$1 AND idempotency_key=$2",
      [user, data.key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return {
        id: old.rows[0].id as string,
        version: old.rows[0].version as number,
      };
    }
    const terms = await loadTerms(c, data.load_id);
    const snap = await snapshot(c, load, data.kind, data.stop_id, terms);
    const id = randomUUID();
    try {
      await c.query(
        `INSERT INTO accessorial_claims(id,load_id,carrier_id,kind,stop_id,claimed_minor,evidence,note,created_by,idempotency_key,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          data.load_id,
          load.carrier_id,
          data.kind,
          data.kind === "detention" ? data.stop_id : null,
          snap.claimed,
          JSON.stringify(snap.evidence),
          data.note,
          user,
          data.key,
          hash,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new HttpError(409, "CLAIM_OPEN");
      throw e;
    }
    await emit(c, user, load.carrier_id, "claim.created", {
      claim_id: id,
      kind: data.kind,
    });
    return { id, version: 1 };
  });
}

async function lockClaim(c: PoolClient, user: string, id: string) {
  const r = await c.query(
    "SELECT * FROM accessorial_claims WHERE id=$1 FOR UPDATE",
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND");
  await member(c, user, row.carrier_id, true);
  return row;
}

/** Re-captures the evidence of a draft (a time was corrected, terms were set). */
export async function refreshClaim(user: string, id: string, input: unknown) {
  const data = versionOnly.parse(input);
  return transaction(async (c) => {
    const row = await lockClaim(c, user, id);
    if (row.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (row.status !== "draft") throw new HttpError(409, "CLAIM_NOT_DRAFT");
    const load = (
      await c.query("SELECT * FROM loads WHERE id=$1", [row.load_id])
    ).rows[0];
    const terms = await loadTerms(c, row.load_id);
    const snap = await snapshot(
      c,
      load,
      row.kind,
      row.stop_id ?? undefined,
      terms,
    );
    await c.query(
      "UPDATE accessorial_claims SET claimed_minor=$2,evidence=$3,version=version+1 WHERE id=$1",
      [id, snap.claimed, JSON.stringify(snap.evidence)],
    );
    await emit(c, user, row.carrier_id, "claim.refreshed", { claim_id: id });
    return { id, version: row.version + 1 };
  });
}

/** Marks the packet as sent by the carrier. After this the evidence is fixed. */
export async function submitClaim(user: string, id: string, input: unknown) {
  const data = versionOnly.parse(input);
  return transaction(async (c) => {
    const row = await lockClaim(c, user, id);
    if (row.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (row.status !== "draft") throw new HttpError(409, "CLAIM_NOT_DRAFT");
    await c.query(
      "UPDATE accessorial_claims SET status='submitted',submitted_at=now(),submitted_by=$2,version=version+1 WHERE id=$1",
      [id, user],
    );
    await emit(c, user, row.carrier_id, "claim.submitted", {
      claim_id: id,
      kind: row.kind,
    });
    return { id, version: row.version + 1 };
  });
}

/** Records what the payer did with a submitted claim. */
export async function settleClaim(user: string, id: string, input: unknown) {
  const data = outcomeSchema.parse(input);
  return transaction(async (c) => {
    const row = await lockClaim(c, user, id);
    if (row.version !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    if (row.status !== "submitted")
      throw new HttpError(409, "CLAIM_NOT_SUBMITTED");
    if (data.outcome === "paid") {
      if (data.settled_minor === undefined)
        throw new HttpError(422, "AMOUNT_REQUIRED");
      if (BigInt(data.settled_minor) > BigInt(row.claimed_minor))
        throw new HttpError(422, "OVER_CLAIMED");
    } else if (data.settled_minor !== undefined) {
      throw new HttpError(422, "VALIDATION_ERROR");
    }
    await c.query(
      `UPDATE accessorial_claims SET status=$2,settled_minor=$3,settled_at=now(),settled_by=$4,outcome_note=$5,version=version+1 WHERE id=$1`,
      [id, data.outcome, data.settled_minor ?? null, user, data.note],
    );
    await emit(c, user, row.carrier_id, "claim." + data.outcome, {
      claim_id: id,
      kind: row.kind,
    });
    return { id, version: row.version + 1 };
  });
}

const dollars = (minor: string) => {
  const n = BigInt(minor);
  return `$${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
};
const when = (s: string | null, zone = "UTC") =>
  s
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(s)) + ` (${zone})`
    : "not recorded";

/** The packet a carrier sends the payer, as a PDF built from the frozen evidence. */
export async function claimPacket(user: string, id: string) {
  const row = await transaction(async (c) => {
    const r = await c.query(`${claimSql} WHERE a.id=$1`, [id]);
    if (!r.rows[0]) throw new HttpError(404, "NOT_FOUND");
    const carrier = await c.query(
      "SELECT carrier_id FROM accessorial_claims WHERE id=$1",
      [id],
    );
    await member(c, user, carrier.rows[0].carrier_id, true);
    return claimView(r.rows[0]);
  });
  const ev = row.evidence as Record<string, any>;
  const lines: string[] = [
    `Load ${row.load_reference}`,
    `Claim: ${row.kind === "detention" ? "Detention" : "Truck ordered not used (TONU)"}  Amount: ${dollars(row.claimed_minor)}`,
    `Evidence captured: ${when(ev.captured_at)}`,
    `Terms source: ${ev.terms.source === "verbal" ? "verbal agreement (not in writing)" : ev.terms.source.replace("_", " ")}`,
    "",
  ];
  if (row.kind === "detention") {
    const zone = ev.stop.timezone as string;
    lines.push(
      `Stop ${ev.stop.sequence}: ${ev.stop.kind} at ${ev.stop.address}`,
      `Appointment window: ${when(ev.stop.window_start, zone)} to ${when(ev.stop.window_end, zone)}`,
      `Free time: ${ev.calc.free_minutes} min. Rate: ${dollars(ev.terms.rate_minor_per_hour)} per hour${ev.terms.cap_minutes ? `, capped at ${ev.terms.cap_minutes} min` : ""}.`,
      `Clock started (later of arrival and window opening): ${when(ev.calc.clock_start, zone)}`,
      `Departed: ${when(ev.calc.departed, zone)}`,
      `Time on site counted: ${ev.calc.dwell_minutes} min. Billable: ${ev.calc.billable_minutes} min${ev.calc.capped ? " (capped)" : ""}.`,
      "",
      "Recorded times (every report, oldest first):",
      ...ev.events.map(
        (e: Record<string, string | null>) =>
          `- ${e.kind} ${when(e.occurred_at, zone)}; recorded ${when(e.recorded_at, zone)} by ${e.recorded_by} (manual report)${e.supersedes ? `; corrects an earlier report: ${e.reason}` : ""}${e.note ? `; note: ${e.note}` : ""}`,
      ),
    );
    if (ev.calc.issues.length)
      lines.push(
        "",
        "Notes for the reader: " + ev.calc.issues.join(", ").replace(/_/g, " "),
      );
  } else {
    lines.push(
      `Dispatched: ${ev.tonu.dispatched_at ? when(ev.tonu.dispatched_at) : "not recorded"}${ev.tonu.dispatched_by ? ` by ${ev.tonu.dispatched_by}` : ""}`,
      `Driver assigned: ${ev.tonu.driver ?? "not recorded"}`,
      `Cancelled: ${when(ev.tonu.cancelled_at)}${ev.tonu.cancelled_by ? ` by ${ev.tonu.cancelled_by}` : ""}`,
      `Reason given: ${ev.tonu.cancel_reason ?? "not recorded"}`,
    );
  }
  lines.push(
    "",
    "Times are reports entered by people in Relay, not readings from the truck. Prepared by Relay for the carrier to send; the carrier is the claimant.",
  );
  return {
    filename: `claim-${row.load_reference}-${row.kind}.pdf`.replace(
      /[^A-Za-z0-9._-]+/g,
      "-",
    ),
    bytes: textPdf({
      title: `${row.kind === "detention" ? "Detention" : "TONU"} claim - load ${row.load_reference}`,
      banner: row.status === "draft" ? "DRAFT - not yet sent" : undefined,
      body: lines.join("\n"),
    }),
  };
}
