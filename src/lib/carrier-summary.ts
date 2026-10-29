import { pool } from "./db";
import { registrationStates } from "./authority";
import type { AuthorityState } from "./authority-state";

export type CarrierSummary = {
  id: string;
  name: string;
  role: "dispatcher" | "carrier-manager";
  authorization: {
    state: "current" | "expiring" | "expired" | "none";
    expires_at: string | null;
    agreement_ref: string | null;
  };
  loads: {
    active: number;
    total: number;
    delivered: number;
    cancelled: number;
  };
  open_exceptions: number;
  drivers: number;
  /** From the latest public-registry lookup for the number on file. */
  registration: AuthorityState;
};

/**
 * One row per carrier the person dispatches or manages (never drivers, never
 * another organization's carriers). Authorization uses the same test as
 * booking: verified, in effect, and not expired.
 */
export async function carrierSummaries(user: string) {
  const { rows } = await pool.query(
    `SELECT c.id,c.name,m.role,
      a.agreement_ref,a.expires_at,
      CASE
        WHEN a.id IS NULL THEN 'none'
        WHEN a.verified_at<=now() AND a.effective_at<=now() AND a.expires_at>now()
          THEN CASE WHEN a.expires_at<now()+interval '30 days' THEN 'expiring' ELSE 'current' END
        ELSE 'expired' END authorization_state,
      (SELECT count(*)::int FROM loads l WHERE l.carrier_id=c.id AND l.cancelled_at IS NULL AND l.stage<>'delivered') active,
      (SELECT count(*)::int FROM loads l WHERE l.carrier_id=c.id) total,
      (SELECT count(*)::int FROM loads l WHERE l.carrier_id=c.id AND l.stage='delivered' AND l.cancelled_at IS NULL) delivered,
      (SELECT count(*)::int FROM loads l WHERE l.carrier_id=c.id AND l.cancelled_at IS NOT NULL) cancelled,
      (SELECT count(*)::int FROM load_exceptions e WHERE e.carrier_id=c.id AND e.status<>'resolved') open_exceptions,
      (SELECT count(*)::int FROM drivers d WHERE d.carrier_id=c.id AND d.onboarding_status<>'removed') drivers
    FROM carriers c
    JOIN memberships m ON m.carrier_id=c.id AND m.user_id=$1 AND m.role IN ('dispatcher','carrier-manager')
    LEFT JOIN LATERAL (
      SELECT * FROM carrier_dispatch_authorizations x WHERE x.carrier_id=c.id
      ORDER BY (x.verified_at<=now() AND x.effective_at<=now() AND x.expires_at>now()) DESC,x.expires_at DESC LIMIT 1
    ) a ON true
    ORDER BY c.name,c.id`,
    [user],
  );
  const registration = await registrationStates(rows.map((r) => r.id));
  const carriers: CarrierSummary[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    authorization: {
      state: r.authorization_state,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      agreement_ref: r.agreement_ref ?? null,
    },
    loads: {
      active: r.active,
      total: r.total,
      delivered: r.delivered,
      cancelled: r.cancelled,
    },
    open_exceptions: r.open_exceptions,
    drivers: r.drivers,
    registration: registration.get(r.id) ?? "unchecked",
  }));
  return { carriers, generated_at: new Date().toISOString() };
}
