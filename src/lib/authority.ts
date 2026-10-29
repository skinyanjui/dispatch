import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError } from "./auth";
import { carrierAccess, emit, once } from "./onboarding";
import { enqueueForUser } from "./notifications";
import {
  deriveAuthority,
  flagLabels,
  type AuthorityCheck,
  type AuthorityFlag,
  type AuthorityState,
  type McOutcome,
} from "./authority-state";

/**
 * Carrier authority and insurance monitoring (ADR 0065). A provider looks up
 * a carrier's public registration by USDOT number; every lookup is stored with
 * its source and observation time, and the screens show both. Nothing is blocked
 * automatically: a registry can be wrong or late, so the result raises a visible
 * flag (and an operations alert) for a person to resolve.
 *
 * Providers: "fixture" (the default; fictional, deterministic, no network) and
 * "fmcsa" (the public QCMobile service; opt in with RELAY_AUTHORITY_PROVIDER=fmcsa
 * and FMCSA_WEBKEY). The fmcsa parser follows the service's documented shape
 * and has not been run against the live service from this repository.
 */
export type Lookup =
  | {
      found: true;
      legal_name: string;
      authority_status: AuthorityCheck["authority_status"];
      allowed_to_operate: boolean | null;
      out_of_service: boolean | null;
      insurance_on_file: boolean | null;
      insurance_shortfall: boolean | null;
      mc_outcome: McOutcome;
      observed_at: string;
    }
  | { found: false; observed_at: string };
export type Provider = {
  source: "fixture" | "fmcsa";
  /** `mc` is the carrier's MC (docket) number, when it has one: the lookup says whether it belongs to this USDOT number. */
  lookup(usdot: string, carrierName: string, mc?: string): Promise<Lookup>;
};

/** Fictional rules keyed on the last digit, so demos and tests can show every state. */
export const fixtureProvider: Provider = {
  source: "fixture",
  async lookup(usdot, carrierName, mc) {
    const last = Number(usdot.slice(-1));
    const observed_at = new Date().toISOString();
    if (last === 9) return { found: false, observed_at };
    return {
      found: true,
      legal_name: last === 6 ? "Unrelated Freight Holdings LLC" : carrierName,
      authority_status:
        last === 8 ? "revoked" : last === 5 ? "inactive" : "active",
      allowed_to_operate: last !== 8,
      out_of_service: last === 4,
      // 7: none on file; 3: some, but less than required.
      insurance_on_file: last !== 7 && last !== 3,
      insurance_shortfall: last === 3 ? true : last === 7 ? false : null,
      // The MC number's last digit: 9 matches nobody, 7 belongs to another carrier.
      mc_outcome: !mc
        ? "not_checked"
        : mc.endsWith("9")
          ? "not_found"
          : mc.endsWith("7")
            ? "different_carrier"
            : "matches",
      observed_at,
    };
  },
};

const yes = (v: unknown) => (v === "Y" ? true : v === "N" ? false : null);
const thousands = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/**
 * Insurance against what the registry says is required: bodily-injury and
 * property damage (amounts, in thousands of dollars), cargo and bond (some on
 * file). Required and missing, or on file but below the required amount, is
 * not insured; where the registry states no requirement, any amount on file is
 * taken as insured and a missing figure as unknown.
 */
export function insuranceFrom(carrier: Record<string, unknown>): {
  insurance_on_file: boolean | null;
  insurance_shortfall: boolean | null;
} {
  const bipd = thousands(carrier.bipdInsuranceOnFile);
  const checks: { required: boolean; ok: boolean; partial: boolean }[] = [];
  const need = (
    required: unknown,
    onFile: number | null,
    amount?: number | null,
  ) => {
    if (required !== "Y") return;
    const some = onFile !== null && onFile > 0;
    const enough = some && (amount == null || onFile! >= amount);
    checks.push({ required: true, ok: enough, partial: some && !enough });
  };
  need(
    carrier.bipdInsuranceRequired,
    bipd,
    thousands(carrier.bipdRequiredAmount),
  );
  need(carrier.cargoInsuranceRequired, thousands(carrier.cargoInsuranceOnFile));
  need(carrier.bondInsuranceRequired, thousands(carrier.bondInsuranceOnFile));
  if (!checks.length)
    return {
      insurance_on_file: bipd === null ? null : bipd > 0,
      insurance_shortfall: bipd !== null && bipd <= 0 ? false : null,
    };
  const short = checks.some((c) => !c.ok);
  return {
    insurance_on_file: !short,
    insurance_shortfall: short ? checks.some((c) => c.partial) : null,
  };
}

/** Parses the public QCMobile carrier response; unknown shapes are an error, never a guess. */
export function parseFmcsa(body: unknown, observed_at: string): Lookup {
  const carrier = (body as { content?: { carrier?: Record<string, unknown> } })
    ?.content?.carrier;
  if (!carrier) return { found: false, observed_at };
  const common = String(carrier.commonAuthorityStatus ?? "");
  const authority: AuthorityCheck["authority_status"] =
    common === "A"
      ? "active"
      : common === "I"
        ? "inactive"
        : common === "N"
          ? "revoked"
          : "unknown";
  return {
    found: true,
    legal_name: String(carrier.legalName ?? "").slice(0, 200),
    authority_status: authority,
    allowed_to_operate: yes(carrier.allowedToOperate),
    out_of_service: yes(carrier.outOfService),
    ...insuranceFrom(carrier),
    mc_outcome: "not_checked",
    observed_at,
  };
}
/** Which USDOT number a docket (MC) number belongs to, from the docket lookup response. */
export function docketOutcome(body: unknown, usdot: string): McOutcome {
  const rows = (body as { content?: unknown })?.content;
  const first = (Array.isArray(rows) ? rows[0] : rows) as
    | { carrier?: { dotNumber?: unknown } }
    | undefined;
  const dot = first?.carrier?.dotNumber;
  if (dot === undefined || dot === null) return "not_found";
  return String(dot) === usdot ? "matches" : "different_carrier";
}
export function fmcsaProvider(
  webKey: string,
  fetcher: typeof fetch = fetch,
): Provider {
  const get = (path: string) =>
    fetcher(
      `https://mobile.fmcsa.dot.gov/qc/services/${path}?webKey=${encodeURIComponent(webKey)}`,
      {
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json" },
      },
    );
  return {
    source: "fmcsa",
    async lookup(usdot, _name, mc) {
      const res = await get(`carriers/${encodeURIComponent(usdot)}`);
      const observed_at = new Date().toISOString();
      if (res.status === 404) return { found: false, observed_at };
      if (!res.ok) throw new Error("PROVIDER_HTTP_" + res.status);
      const found = parseFmcsa(await res.json(), observed_at);
      if (!found.found || !mc) return found;
      // Does the MC number belong to this USDOT number? A sold or hijacked
      // registration answers with someone else's.
      const dock = await get(
        `carriers/docket-number/${encodeURIComponent(mc)}`,
      );
      if (dock.status === 404) return { ...found, mc_outcome: "not_found" };
      if (!dock.ok) throw new Error("PROVIDER_HTTP_" + dock.status);
      return { ...found, mc_outcome: docketOutcome(await dock.json(), usdot) };
    },
  };
}
/**
 * In production a lookup needs a real provider (or the fixture chosen on
 * purpose with RELAY_AUTHORITY_PROVIDER=fixture), so a fictional result is
 * never recorded as if it came from the registry.
 */
export function configuredProvider(): Provider {
  const chosen = process.env.RELAY_AUTHORITY_PROVIDER;
  if (chosen === "fmcsa") {
    if (!process.env.FMCSA_WEBKEY)
      throw new HttpError(503, "AUTHORITY_PROVIDER_NOT_CONFIGURED");
    return fmcsaProvider(process.env.FMCSA_WEBKEY);
  }
  if (chosen === "fixture" || process.env.NODE_ENV !== "production")
    return fixtureProvider;
  throw new HttpError(503, "AUTHORITY_PROVIDER_NOT_CONFIGURED");
}

const rowToCheck = (r: Record<string, unknown>): AuthorityCheck => ({
  outcome: r.outcome as AuthorityCheck["outcome"],
  source: r.source as AuthorityCheck["source"],
  legal_name: r.legal_name as string,
  authority_status: r.authority_status as AuthorityCheck["authority_status"],
  allowed_to_operate: r.allowed_to_operate as boolean | null,
  out_of_service: r.out_of_service as boolean | null,
  insurance_on_file: r.insurance_on_file as boolean | null,
  insurance_shortfall: (r.insurance_shortfall as boolean | null) ?? null,
  mc_outcome: ((r.mc_outcome as McOutcome | undefined) ??
    "not_checked") as McOutcome,
  observed_at: new Date(r.observed_at as string).toISOString(),
});

type Db = Pick<typeof pool, "query">;
/**
 * The latest lookups for the number now on file. A lookup only speaks for the
 * USDOT number it was made for: after the number changes, the old result must
 * not make the new number look clear (ADR 0070).
 */
async function latestChecks(
  c: Db,
  carrierId: string,
  usdot: string,
  mc: string,
) {
  const { rows } = await c.query(
    `SELECT * FROM carrier_authority_checks WHERE carrier_id=$1 AND usdot=$2 AND mc_number=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [carrierId, usdot, mc],
  );
  const ok = await c.query(
    `SELECT * FROM carrier_authority_checks WHERE carrier_id=$1 AND usdot=$2 AND mc_number=$3 AND outcome='ok' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [carrierId, usdot, mc],
  );
  const other = await c.query(
    `SELECT 1 FROM carrier_authority_checks WHERE carrier_id=$1 AND (usdot<>$2 OR mc_number<>$3) LIMIT 1`,
    [carrierId, usdot, mc],
  );
  return {
    latest: rows[0] ? rowToCheck(rows[0]) : null,
    lastOk: ok.rows[0] ? rowToCheck(ok.rows[0]) : null,
    numberChanged: !rows[0] && (other.rowCount ?? 0) > 0,
  };
}

/** Seconds between lookups of one carrier by hand; RELAY_AUTHORITY_COOLDOWN_SECONDS, default 60. */
export function checkCooldownSeconds() {
  const n = Number(process.env.RELAY_AUTHORITY_COOLDOWN_SECONDS ?? 60);
  return Number.isInteger(n) && n >= 0 && n <= 3600 ? n : 60;
}

/** What the screens show for one carrier. */
export async function authorityStatus(user: string, carrierId: string) {
  const carrier = await transaction((c) => carrierAccess(c, user, carrierId));
  const profile = await pool.query(
    "SELECT usdot,mc_number FROM carrier_profiles WHERE carrier_id=$1",
    [carrierId],
  );
  const usdot = (profile.rows[0]?.usdot as string | undefined) ?? "";
  const mc = (profile.rows[0]?.mc_number as string | undefined) ?? "";
  const { latest, lastOk, numberChanged } = await latestChecks(
    pool,
    carrierId,
    usdot,
    mc,
  );
  return {
    carrier_id: carrierId,
    usdot,
    mc_number: mc,
    provider: configuredProviderName(),
    ...deriveAuthority(
      latest,
      lastOk,
      carrier.name as string,
      new Date(),
      numberChanged,
    ),
    legal_name: (lastOk ?? latest)?.legal_name ?? "",
  };
}
const configuredProviderName = () => {
  try {
    return configuredProvider().source;
  } catch {
    return null;
  }
};

/** Looks one carrier up now and stores what came back, success or failure. */
async function recordLookup(
  c: Db,
  carrierId: string,
  carrierName: string,
  usdot: string,
  mc: string,
  provider: Provider,
  by: string | null,
) {
  let lookup: Lookup | null = null;
  let error: string | null = null;
  try {
    lookup = await provider.lookup(usdot, carrierName, mc || undefined);
  } catch (e) {
    // A fixed vocabulary: provider messages can name hosts and addresses.
    const message = e instanceof Error ? e.message : "";
    error = /^PROVIDER_HTTP_\d{3}$/.test(message)
      ? message
      : e instanceof Error &&
          (e.name === "TimeoutError" || e.name === "AbortError")
        ? "TIMEOUT"
        : "LOOKUP_FAILED";
  }
  const outcome = error ? "error" : lookup!.found ? "ok" : "not_found";
  const l = lookup && lookup.found ? lookup : null;
  const id = randomUUID();
  // What the carrier looked like at the previous lookup, whatever its number.
  const previous = (
    await c.query(
      "SELECT usdot,mc_number FROM carrier_authority_checks WHERE carrier_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [carrierId],
    )
  ).rows[0];
  const before = previous
    ? await stateOf(
        c,
        carrierId,
        carrierName,
        previous.usdot,
        previous.mc_number,
      )
    : { state: "unchecked" as AuthorityState, flags: [] as AuthorityFlag[] };
  await c.query(
    `INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,legal_name,authority_status,
       allowed_to_operate,out_of_service,insurance_on_file,insurance_shortfall,mc_number,mc_outcome,error_code,observed_at,checked_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      carrierId,
      usdot,
      provider.source,
      outcome,
      l?.legal_name ?? "",
      l?.authority_status ?? "unknown",
      l?.allowed_to_operate ?? null,
      l?.out_of_service ?? null,
      l?.insurance_on_file ?? null,
      l?.insurance_shortfall ?? null,
      mc,
      l?.mc_outcome ?? "not_checked",
      error,
      lookup?.observed_at ?? new Date().toISOString(),
      by,
    ],
  );
  const after = await stateOf(c, carrierId, carrierName, usdot, mc);
  // A carrier that turns to "attention" is told to the people who dispatch for
  // it, once; a failed lookup is the operations alert's business (ADR 0072).
  const reasons = after.flags.filter((f) => f !== "lookup_failed");
  const alreadyFlagged = before.state === "attention";
  if (after.state === "attention" && !alreadyFlagged && reasons.length)
    await notifyRegistration(carrierId, carrierName, id, reasons);
  return { id, outcome };
}

async function stateOf(
  c: Db,
  carrierId: string,
  carrierName: string,
  usdot: string,
  mc: string,
) {
  const { latest, lastOk, numberChanged } = await latestChecks(
    c,
    carrierId,
    usdot,
    mc,
  );
  return deriveAuthority(
    latest,
    lastOk,
    carrierName,
    new Date(),
    numberChanged,
  );
}

async function notifyRegistration(
  carrierId: string,
  carrierName: string,
  checkId: string,
  reasons: AuthorityFlag[],
) {
  await transaction(async (c) => {
    const people = await c.query(
      `SELECT DISTINCT u.id,car.organization_id FROM carriers car
         JOIN users u ON EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=car.id AND m.user_id=u.id
                                AND m.role IN ('dispatcher','carrier-manager'))
           OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=car.organization_id AND om.user_id=u.id)
       WHERE car.id=$1`,
      [carrierId],
    );
    for (const p of people.rows)
      await enqueueForUser(c, p.id, {
        kind: "registration_alert",
        organization: p.organization_id,
        dedupe: `registration_alert:${checkId}:${p.id}`,
        subject: `${carrierName}: registration needs attention`.slice(0, 200),
        text: `The latest public registration lookup for ${carrierName} found:\n\n${reasons.map((f) => "- " + flagLabels[f]).join("\n")}\n\nReview it under Carriers, then the carrier's files. Do not book new freight on this carrier until someone has looked.`,
      });
  });
}

/** Registration state for several carriers the caller can already see. */
export async function registrationStates(carrierIds: string[]) {
  const out = new Map<string, AuthorityState>();
  if (!carrierIds.length) return out;
  const { rows } = await pool.query(
    `SELECT c.id,c.name,p.usdot,p.mc_number mc FROM carriers c
       LEFT JOIN carrier_profiles p ON p.carrier_id=c.id WHERE c.id=ANY($1::uuid[])`,
    [carrierIds],
  );
  for (const r of rows)
    out.set(
      r.id,
      r.usdot
        ? (await stateOf(pool, r.id, r.name, r.usdot, r.mc ?? "")).state
        : "unchecked",
    );
  return out;
}

const checkInput = z.object({ carrier_id: z.uuid(), key: z.uuid() }).strict();
/** "Check now" for a dispatcher or carrier manager of the carrier. */
export async function checkAuthority(
  user: string,
  input: unknown,
  provider?: Provider,
) {
  const data = checkInput.parse(input);
  provider ??= configuredProvider();
  const carrier = await transaction((c) =>
    carrierAccess(c, user, data.carrier_id),
  );
  const profile = await pool.query(
    "SELECT usdot,mc_number FROM carrier_profiles WHERE carrier_id=$1",
    [data.carrier_id],
  );
  const usdot = (profile.rows[0]?.usdot as string | undefined) ?? "";
  const mc = (profile.rows[0]?.mc_number as string | undefined) ?? "";
  if (!usdot) throw new HttpError(422, "USDOT_REQUIRED");
  await transaction((c) =>
    once(c, user, data.key, "authority.check", data, async () => {
      // A person pressing "Check now" repeatedly would hammer the public
      // service; a replay of the same request is answered before this point.
      const recent = await c.query(
        "SELECT 1 FROM carrier_authority_checks WHERE carrier_id=$1 AND created_at>now()-make_interval(secs=>$2::int) LIMIT 1",
        [data.carrier_id, checkCooldownSeconds()],
      );
      if (recent.rowCount) throw new HttpError(429, "CHECK_TOO_SOON");
      const done = await recordLookup(
        c,
        data.carrier_id,
        carrier.name as string,
        usdot,
        mc,
        provider,
        user,
      );
      await emit(c, user, data.carrier_id, "authority.checked", {
        outcome: done.outcome,
        source: provider.source,
      });
      return { outcome: done.outcome };
    }),
  );
  return authorityStatus(user, data.carrier_id);
}

/**
 * The daily job: re-checks carriers with a USDOT number whose last check is
 * old. It works within a time budget (each lookup can take up to its own
 * timeout, so a serverless function limit is not overrun) with a few lookups at
 * once, and leaves what it did not reach for the next run, reporting how many.
 * A failed lookup is retried after an hour, then daily once it has failed four
 * times in a row (and the operations alert says so).
 */
export async function runAuthorityChecks(
  limit = 50,
  provider: Provider | null = configuredProviderName()
    ? configuredProvider()
    : null,
  options: { budgetMs?: number; concurrency?: number } = {},
) {
  if (!provider) return { skipped: "no provider configured" };
  const budgetMs =
    options.budgetMs ??
    Number(process.env.RELAY_AUTHORITY_JOB_BUDGET_MS ?? 30000);
  const concurrency = options.concurrency ?? 4;
  const due = await pool.query(
    `SELECT c.id,c.name,p.usdot,p.mc_number mc FROM carriers c JOIN carrier_profiles p ON p.carrier_id=c.id
     LEFT JOIN LATERAL (SELECT outcome,created_at,usdot,mc_number,
        (SELECT count(*) FROM (SELECT outcome FROM carrier_authority_checks x WHERE x.carrier_id=c.id ORDER BY created_at DESC,id DESC LIMIT 4) z WHERE z.outcome='error') errors
       FROM carrier_authority_checks k WHERE k.carrier_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) last ON true
     WHERE p.usdot<>'' AND p.step='complete' AND (
       last.created_at IS NULL
       OR last.usdot<>p.usdot OR last.mc_number<>p.mc_number
       OR last.created_at<now()-interval '20 hours'
       OR (last.outcome='error' AND last.errors<4 AND last.created_at<now()-interval '1 hour'))
     ORDER BY last.created_at NULLS FIRST LIMIT $1`,
    [limit],
  );
  const started = Date.now();
  const queue = [...due.rows];
  let checked = 0;
  let failed = 0;
  const worker = async () => {
    // A lookup already under way finishes; no new one starts after the budget.
    while (queue.length && Date.now() - started < budgetMs) {
      const r = queue.shift()!;
      const out = await recordLookup(
        pool,
        r.id,
        r.name,
        r.usdot,
        r.mc,
        provider,
        null,
      );
      checked++;
      if (out.outcome === "error") failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { checked, failed, deferred: queue.length };
}

/** Carriers whose last four lookups all failed: the registry or the key may be down. */
export async function authorityFailing(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM (
       SELECT c.id FROM carriers c JOIN carrier_profiles p ON p.carrier_id=c.id
       WHERE p.usdot<>'' AND p.step='complete' AND (
         SELECT count(*) FROM (SELECT outcome FROM carrier_authority_checks x WHERE x.carrier_id=c.id ORDER BY created_at DESC,id DESC LIMIT 4) z WHERE z.outcome='error') >= 4
     ) f`,
  );
  return rows[0].n as number;
}

/** Carriers whose latest lookup needs a person (for the operations alert). */
export async function authorityAttention(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT c.name,l.outcome,l.source,l.legal_name,l.authority_status,l.allowed_to_operate,l.out_of_service,
       l.insurance_on_file,l.insurance_shortfall,l.mc_outcome,l.observed_at,
       o.outcome ok_outcome,o.source ok_source,o.legal_name ok_legal_name,o.authority_status ok_authority_status,
       o.allowed_to_operate ok_allowed_to_operate,o.out_of_service ok_out_of_service,
       o.insurance_on_file ok_insurance_on_file,o.insurance_shortfall ok_insurance_shortfall,o.mc_outcome ok_mc_outcome,o.observed_at ok_observed_at,
       (l.outcome IS NULL AND EXISTS(SELECT 1 FROM carrier_authority_checks k WHERE k.carrier_id=c.id)) number_changed
     FROM carriers c
     LEFT JOIN carrier_profiles p ON p.carrier_id=c.id
     LEFT JOIN LATERAL (SELECT * FROM carrier_authority_checks k WHERE k.carrier_id=c.id AND k.usdot=COALESCE(p.usdot,'') AND k.mc_number=COALESCE(p.mc_number,'') ORDER BY created_at DESC,id DESC LIMIT 1) l ON true
     LEFT JOIN LATERAL (SELECT * FROM carrier_authority_checks k WHERE k.carrier_id=c.id AND k.usdot=COALESCE(p.usdot,'') AND k.mc_number=COALESCE(p.mc_number,'') AND k.outcome='ok' ORDER BY created_at DESC,id DESC LIMIT 1) o ON true`,
  );
  return rows.filter((r) => {
    const latest = r.outcome ? rowToCheck(r) : null;
    const ok = r.ok_outcome
      ? rowToCheck({
          outcome: r.ok_outcome,
          source: r.ok_source,
          legal_name: r.ok_legal_name,
          authority_status: r.ok_authority_status,
          allowed_to_operate: r.ok_allowed_to_operate,
          out_of_service: r.ok_out_of_service,
          insurance_on_file: r.ok_insurance_on_file,
          insurance_shortfall: r.ok_insurance_shortfall,
          mc_outcome: r.ok_mc_outcome,
          observed_at: r.ok_observed_at,
        })
      : null;
    return (
      deriveAuthority(latest, ok, r.name, new Date(), r.number_changed)
        .state === "attention"
    );
  }).length;
}
