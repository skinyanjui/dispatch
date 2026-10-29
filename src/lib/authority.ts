import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { HttpError } from "./auth";
import { carrierAccess, emit, once } from "./onboarding";
import { deriveAuthority, type AuthorityCheck } from "./authority-state";

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
      observed_at: string;
    }
  | { found: false; observed_at: string };
export type Provider = {
  source: "fixture" | "fmcsa";
  lookup(usdot: string, carrierName: string): Promise<Lookup>;
};

/** Fictional rules keyed on the last digit, so demos and tests can show every state. */
export const fixtureProvider: Provider = {
  source: "fixture",
  async lookup(usdot, carrierName) {
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
      insurance_on_file: last !== 7,
      observed_at,
    };
  },
};

const yes = (v: unknown) => (v === "Y" ? true : v === "N" ? false : null);
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
  const insured = Number(carrier.bipdInsuranceOnFile ?? NaN);
  return {
    found: true,
    legal_name: String(carrier.legalName ?? "").slice(0, 200),
    authority_status: authority,
    allowed_to_operate: yes(carrier.allowedToOperate),
    out_of_service: yes(carrier.outOfService),
    insurance_on_file: Number.isFinite(insured) ? insured > 0 : null,
    observed_at,
  };
}
export function fmcsaProvider(
  webKey: string,
  fetcher: typeof fetch = fetch,
): Provider {
  return {
    source: "fmcsa",
    async lookup(usdot) {
      const res = await fetcher(
        `https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(usdot)}?webKey=${encodeURIComponent(webKey)}`,
        {
          signal: AbortSignal.timeout(8000),
          headers: { accept: "application/json" },
        },
      );
      const observed_at = new Date().toISOString();
      if (res.status === 404) return { found: false, observed_at };
      if (!res.ok) throw new Error("PROVIDER_HTTP_" + res.status);
      return parseFmcsa(await res.json(), observed_at);
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
  observed_at: new Date(r.observed_at as string).toISOString(),
});

type Db = Pick<typeof pool, "query">;
/**
 * The latest lookups for the number now on file. A lookup only speaks for the
 * USDOT number it was made for: after the number changes, the old result must
 * not make the new number look clear (ADR 0070).
 */
async function latestChecks(c: Db, carrierId: string, usdot: string) {
  const { rows } = await c.query(
    `SELECT * FROM carrier_authority_checks WHERE carrier_id=$1 AND usdot=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [carrierId, usdot],
  );
  const ok = await c.query(
    `SELECT * FROM carrier_authority_checks WHERE carrier_id=$1 AND usdot=$2 AND outcome='ok' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [carrierId, usdot],
  );
  const other = await c.query(
    `SELECT 1 FROM carrier_authority_checks WHERE carrier_id=$1 AND usdot<>$2 LIMIT 1`,
    [carrierId, usdot],
  );
  return {
    latest: rows[0] ? rowToCheck(rows[0]) : null,
    lastOk: ok.rows[0] ? rowToCheck(ok.rows[0]) : null,
    numberChanged: !rows[0] && (other.rowCount ?? 0) > 0,
  };
}

/** What the screens show for one carrier. */
export async function authorityStatus(user: string, carrierId: string) {
  const carrier = await transaction((c) => carrierAccess(c, user, carrierId));
  const profile = await pool.query(
    "SELECT usdot FROM carrier_profiles WHERE carrier_id=$1",
    [carrierId],
  );
  const usdot = (profile.rows[0]?.usdot as string | undefined) ?? "";
  const { latest, lastOk, numberChanged } = await latestChecks(
    pool,
    carrierId,
    usdot,
  );
  return {
    carrier_id: carrierId,
    usdot,
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
  provider: Provider,
  by: string | null,
) {
  let lookup: Lookup | null = null;
  let error: string | null = null;
  try {
    lookup = await provider.lookup(usdot, carrierName);
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
  await c.query(
    `INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,legal_name,authority_status,
       allowed_to_operate,out_of_service,insurance_on_file,error_code,observed_at,checked_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      error,
      lookup?.observed_at ?? new Date().toISOString(),
      by,
    ],
  );
  return { id, outcome };
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
    "SELECT usdot FROM carrier_profiles WHERE carrier_id=$1",
    [data.carrier_id],
  );
  const usdot = (profile.rows[0]?.usdot as string | undefined) ?? "";
  if (!usdot) throw new HttpError(422, "USDOT_REQUIRED");
  await transaction((c) =>
    once(c, user, data.key, "authority.check", data, async () => {
      const done = await recordLookup(
        c,
        data.carrier_id,
        carrier.name as string,
        usdot,
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
 * old, a bounded number per run. A failed lookup is retried after an hour,
 * then daily once it has failed four times in a row.
 */
export async function runAuthorityChecks(
  limit = 50,
  provider: Provider | null = configuredProviderName()
    ? configuredProvider()
    : null,
) {
  if (!provider) return { skipped: "no provider configured" };
  const due = await pool.query(
    `SELECT c.id,c.name,p.usdot FROM carriers c JOIN carrier_profiles p ON p.carrier_id=c.id
     LEFT JOIN LATERAL (SELECT outcome,created_at,usdot,
        (SELECT count(*) FROM (SELECT outcome FROM carrier_authority_checks x WHERE x.carrier_id=c.id ORDER BY created_at DESC,id DESC LIMIT 4) z WHERE z.outcome='error') errors
       FROM carrier_authority_checks k WHERE k.carrier_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) last ON true
     WHERE p.usdot<>'' AND p.step='complete' AND (
       last.created_at IS NULL
       OR last.usdot<>p.usdot
       OR last.created_at<now()-interval '20 hours'
       OR (last.outcome='error' AND last.errors<4 AND last.created_at<now()-interval '1 hour'))
     ORDER BY last.created_at NULLS FIRST LIMIT $1`,
    [limit],
  );
  let checked = 0;
  let failed = 0;
  for (const r of due.rows) {
    const out = await recordLookup(pool, r.id, r.name, r.usdot, provider, null);
    checked++;
    if (out.outcome === "error") failed++;
  }
  return { checked, failed };
}

/** Carriers whose latest lookup needs a person (for the operations alert). */
export async function authorityAttention(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT c.name,l.outcome,l.source,l.legal_name,l.authority_status,l.allowed_to_operate,l.out_of_service,
       l.insurance_on_file,l.observed_at,
       o.outcome ok_outcome,o.source ok_source,o.legal_name ok_legal_name,o.authority_status ok_authority_status,
       o.allowed_to_operate ok_allowed_to_operate,o.out_of_service ok_out_of_service,
       o.insurance_on_file ok_insurance_on_file,o.observed_at ok_observed_at,
       (l.outcome IS NULL AND EXISTS(SELECT 1 FROM carrier_authority_checks k WHERE k.carrier_id=c.id)) number_changed
     FROM carriers c
     LEFT JOIN carrier_profiles p ON p.carrier_id=c.id
     LEFT JOIN LATERAL (SELECT * FROM carrier_authority_checks k WHERE k.carrier_id=c.id AND k.usdot=COALESCE(p.usdot,'') ORDER BY created_at DESC,id DESC LIMIT 1) l ON true
     LEFT JOIN LATERAL (SELECT * FROM carrier_authority_checks k WHERE k.carrier_id=c.id AND k.usdot=COALESCE(p.usdot,'') AND k.outcome='ok' ORDER BY created_at DESC,id DESC LIMIT 1) o ON true`,
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
          observed_at: r.ok_observed_at,
        })
      : null;
    return (
      deriveAuthority(latest, ok, r.name, new Date(), r.number_changed)
        .state === "attention"
    );
  }).length;
}
