import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { consumeAttempt, digest, HttpError, verifyPassword } from "./auth";
import { consumeSecondFactor } from "./account";
import { enqueueForUser } from "./notifications";
import { carrierAccess, emit, once, writeCompanyDetails } from "./onboarding";
import { editLoadIn, editSchema } from "./load-changes";

/**
 * Change control (ADR 0064). Payout instructions, a carrier contact's phone or
 * email, and a stop address after dispatch are the details impostors change.
 * Each such change is requested by one person and takes effect only when a
 * different person who works for the carrier, or administers the organization,
 * approves it after confirming it another way (a call to a number already on
 * record, a document, or in person). Payout changes then wait out a cooling-off
 * period before they count. The database refuses an approval by the requester.
 */
export const changeKinds = [
  "payout_details",
  "contact_details",
  "reroute",
  "carrier_profile",
] as const;
export type ChangeKind = (typeof changeKinds)[number];
export const verificationMethods = [
  "callback",
  "document",
  "in_person",
] as const;

/** Hours before approved payout details count; RELAY_PAYOUT_COOLING_HOURS, 0 to 168. */
export function coolingHours(): number {
  const n = Number(process.env.RELAY_PAYOUT_COOLING_HOURS ?? 24);
  return Number.isInteger(n) && n >= 0 && n <= 168 ? n : 24;
}

const key = z.uuid();
export const payoutSchema = z
  .object({
    carrier_id: z.uuid(),
    payee_name: z.string().trim().min(1).max(160),
    method: z.enum(["ach", "wire", "check", "factor"]),
    account_last4: z
      .string()
      .trim()
      .regex(
        /^([0-9]{4})?$/,
        "Use the last four digits only, or leave it empty",
      ),
    reason: z.string().trim().min(1).max(500),
    key,
  })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    verification: z.enum(verificationMethods).optional(),
    note: z.string().trim().max(500).default(""),
    // Approving needs the approver's password again, and an authenticator or
    // recovery code if they use two-step verification (ADR 0070).
    password: z.string().max(256).optional(),
    code: z.string().max(40).optional(),
  })
  .strict();

/**
 * Step-up for an approval: a stolen or left-open session alone cannot approve a
 * payout change. Wrong attempts are limited per person.
 */
async function stepUp(
  c: PoolClient,
  user: string,
  password: string | undefined,
  code: string | undefined,
) {
  // Only failures count, so a person approving several changes is not locked
  // out, but six wrong tries in five minutes lock approvals even for the right
  // password.
  const identity = "stepup:" + user;
  const used = await pool.query(
    "SELECT attempts FROM login_attempts WHERE identity_hash=$1 AND resets_at>now()",
    [digest(identity)],
  );
  if ((used.rows[0]?.attempts ?? 0) >= 6)
    throw new HttpError(429, "TRY_AGAIN_LATER");
  const fail = async (status: number, error: string): Promise<never> => {
    await consumeAttempt(identity, 1_000_000, 300);
    throw new HttpError(status, error);
  };
  if (!password) throw new HttpError(422, "STEP_UP_REQUIRED");
  const { rows } = await c.query(
    "SELECT password_hash,mfa_enabled_at FROM users WHERE id=$1",
    [user],
  );
  let matches = false;
  try {
    matches = await verifyPassword(password, rows[0].password_hash);
  } catch {
    // An account with no usable password cannot step up and must set one.
  }
  if (!matches) return fail(403, "STEP_UP_FAILED");
  if (rows[0].mfa_enabled_at) {
    if (!code) throw new HttpError(422, "MFA_CODE_REQUIRED");
    if (!(await consumeSecondFactor(c, user, code)))
      return fail(422, "INVALID_MFA_CODE");
  }
}

/** A request nobody decides within this many days lapses, freeing the slot (ADR 0071). */
export const changeExpiryDays = 7;
const expiredNote =
  "Expired after " + changeExpiryDays + " days without a decision";

/** People who may decide changes for a carrier, other than the requester. */
async function approversOf(c: PoolClient, carrierId: string, except: string) {
  const r = await c.query(
    `SELECT u.id,car.organization_id FROM carriers car
       JOIN users u ON u.id<>$2 AND (
         EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=car.id AND m.user_id=u.id AND m.role='carrier-manager')
         OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=car.organization_id AND om.user_id=u.id))
     WHERE car.id=$1`,
    [carrierId, except],
  );
  return r.rows as { id: string; organization_id: string }[];
}

/**
 * Lets lapsed requests go: a pending request older than the limit is closed
 * (as withdrawn by its requester, with a note), so it cannot block a new one
 * forever. Returns how many were closed.
 */
export async function expireStaleChanges(c?: PoolClient, carrierId?: string) {
  const run = async (client: PoolClient) => {
    const r = await client.query(
      `UPDATE sensitive_changes SET status='cancelled',decided_by=requested_by,decided_at=now(),decision_note=$1
       WHERE status='pending' AND requested_at<now()-make_interval(days=>$2) AND ($3::uuid IS NULL OR carrier_id=$3)
       RETURNING id,carrier_id,requested_by,kind`,
      [expiredNote, changeExpiryDays, carrierId ?? null],
    );
    for (const row of r.rows)
      await emit(client, row.requested_by, row.carrier_id, "change.expired", {
        change_id: row.id,
        kind: row.kind,
      });
    return r.rowCount ?? 0;
  };
  return c ? run(c) : transaction(run);
}

/** Parks a change for a second person. Returns the change id. */
export async function requestChange(
  c: PoolClient,
  user: string,
  input: {
    carrierId: string;
    kind: ChangeKind;
    subjectId: string | null;
    summary: string;
    current: unknown;
    proposed: unknown;
    reason: string;
  },
): Promise<string> {
  const id = randomUUID();
  // A request that lapsed must not block asking again.
  await expireStaleChanges(c, input.carrierId);
  try {
    await c.query(
      `INSERT INTO sensitive_changes(id,carrier_id,kind,subject_id,summary,current_value,proposed_value,reason,requested_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.carrierId,
        input.kind,
        input.subjectId,
        input.summary,
        JSON.stringify(input.current),
        JSON.stringify(input.proposed),
        input.reason || "No reason given",
        user,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new HttpError(409, "CHANGE_PENDING");
    throw e;
  }
  await emit(c, user, input.carrierId, "change.requested", {
    change_id: id,
    kind: input.kind,
  });
  // Tell the people who can decide it, once each; muting the kind is theirs to choose.
  for (const a of await approversOf(c, input.carrierId, user))
    await enqueueForUser(c, a.id, {
      kind: "approval_request",
      organization: a.organization_id,
      dedupe: `approval_request:${id}:${a.id}`,
      subject: `A change is waiting for your approval: ${input.summary}`.slice(
        0,
        200,
      ),
      text: `${input.summary}\n\nWhy: ${input.reason}\n\nReview it in Relay (Carriers, then the carrier's files). It lapses after ${changeExpiryDays} days if nobody decides.`,
    });
  return id;
}

/** The payout instructions that count today, and whether they are still cooling. */
export async function payoutDetails(
  c: PoolClient | typeof pool,
  carrierId: string,
) {
  const { rows } = await c.query(
    `SELECT payee_name,method,account_last4,effective_at,effective_at>now() cooling
     FROM carrier_payout_details WHERE carrier_id=$1`,
    [carrierId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    payee_name: r.payee_name as string,
    method: r.method as string,
    account_last4: r.account_last4 as string,
    effective_at: new Date(r.effective_at).toISOString(),
    cooling_off: r.cooling as boolean,
  };
}

/** Asks to change a carrier's payout details. Nothing changes until approved. */
export async function requestPayoutChange(user: string, input: unknown) {
  const data = payoutSchema.parse(input);
  return transaction(async (c) => {
    await carrierAccess(c, user, data.carrier_id);
    return once(c, user, data.key, "change.payout", data, async () => {
      const current = await payoutDetails(c, data.carrier_id);
      const id = await requestChange(c, user, {
        carrierId: data.carrier_id,
        kind: "payout_details",
        subjectId: null,
        summary: `Payout to ${data.payee_name} by ${data.method}${data.account_last4 ? ` ending ${data.account_last4}` : ""}`,
        current: current ?? {},
        proposed: {
          payee_name: data.payee_name,
          method: data.method,
          account_last4: data.account_last4,
        },
        reason: data.reason,
      });
      return { id, status: "pending" };
    });
  });
}

/** May this person decide changes for the carrier (not counting separation of duties)? */
async function mayDecide(c: PoolClient, user: string, carrierId: string) {
  const r = await c.query(
    `SELECT 1 FROM carriers car
     WHERE car.id=$2 AND (
       EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=car.id AND m.user_id=$1 AND m.role='carrier-manager')
       OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=car.organization_id AND om.user_id=$1))`,
    [user, carrierId],
  );
  return r.rowCount === 1;
}

/** Anyone who works for the carrier may see its changes. */
async function mayRead(
  c: PoolClient | typeof pool,
  user: string,
  carrierId: string,
) {
  const r = await c.query(
    `SELECT 1 FROM carriers car
     WHERE car.id=$2 AND (
       EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=car.id AND m.user_id=$1 AND m.role IN ('dispatcher','carrier-manager'))
       OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=car.organization_id AND om.user_id=$1))`,
    [user, carrierId],
  );
  return r.rowCount === 1;
}

const view = (r: Record<string, unknown>, user: string, decide: boolean) => ({
  id: r.id as string,
  kind: r.kind as ChangeKind,
  summary: r.summary as string,
  reason: r.reason as string,
  status: r.status as string,
  current: r.current_value,
  proposed: r.proposed_value,
  requested_by_name: r.requester_name as string,
  requested_at: new Date(r.requested_at as string).toISOString(),
  decided_by_name: (r.decider_name as string | null) ?? null,
  decided_at: r.decided_at
    ? new Date(r.decided_at as string).toISOString()
    : null,
  decision_note: r.decision_note as string,
  verification: (r.verification as string | null) ?? null,
  effective_at: r.effective_at
    ? new Date(r.effective_at as string).toISOString()
    : null,
  // The requester cannot approve their own change; the screen hides the button.
  can_decide: decide && r.status === "pending" && r.requested_by !== user,
  can_cancel: r.status === "pending" && r.requested_by === user,
  expired: r.status === "cancelled" && r.decision_note === expiredNote,
});

/** Pending and recent changes for one carrier, with the payout details in force. */
export async function listChanges(user: string, carrierId: string) {
  if (!(await mayRead(pool, user, carrierId)))
    throw new HttpError(404, "NOT_FOUND");
  const decide = await transaction((c) => mayDecide(c, user, carrierId));
  const rows = await pool.query(
    `SELECT s.*,ru.name requester_name,du.name decider_name
     FROM sensitive_changes s JOIN users ru ON ru.id=s.requested_by LEFT JOIN users du ON du.id=s.decided_by
     WHERE s.carrier_id=$1 ORDER BY (s.status='pending') DESC,s.requested_at DESC,s.id LIMIT 50`,
    [carrierId],
  );
  return {
    cooling_hours: coolingHours(),
    payout_details: await payoutDetails(pool, carrierId),
    can_decide: decide,
    changes: rows.rows.map((r) => view(r, user, decide)),
  };
}

/** Pending changes across the carriers a person can decide for, by carrier (for the banner). */
export async function pendingCount(user: string) {
  await expireStaleChanges();
  const r = await pool.query(
    `SELECT car.id carrier_id,car.name,count(*)::int n FROM sensitive_changes s JOIN carriers car ON car.id=s.carrier_id
     WHERE s.status='pending' AND s.requested_by<>$1 AND (
       EXISTS(SELECT 1 FROM memberships m WHERE m.carrier_id=car.id AND m.user_id=$1 AND m.role='carrier-manager')
       OR EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=car.organization_id AND om.user_id=$1))
     GROUP BY car.id,car.name ORDER BY car.name`,
    [user],
  );
  return {
    pending: r.rows.reduce((t, x) => t + (x.n as number), 0),
    carriers: r.rows.map((x) => ({
      carrier_id: x.carrier_id as string,
      name: x.name as string,
      count: x.n as number,
    })),
  };
}

async function lockChange(c: PoolClient, user: string, id: string) {
  const r = await c.query(
    "SELECT * FROM sensitive_changes WHERE id=$1 FOR UPDATE",
    [id],
  );
  const row = r.rows[0];
  // A change for a carrier the person has nothing to do with does not exist.
  if (!row || !(await mayRead(c, user, row.carrier_id)))
    throw new HttpError(404, "NOT_FOUND");
  return row;
}

/** The requester withdraws their own pending change. */
export async function cancelChange(user: string, id: string) {
  return transaction(async (c) => {
    const row = await lockChange(c, user, id);
    if (row.requested_by !== user) throw new HttpError(404, "NOT_FOUND");
    if (row.status !== "pending") throw new HttpError(409, "CHANGE_DECIDED");
    await c.query(
      "UPDATE sensitive_changes SET status='cancelled',decided_by=$2,decided_at=now() WHERE id=$1",
      [id, user],
    );
    await emit(c, user, row.carrier_id, "change.cancelled", { change_id: id });
    return { id, status: "cancelled" };
  });
}

/** Approves or rejects a change. Never the requester; approval needs a verification method. */
export async function decideChange(user: string, id: string, input: unknown) {
  const data = decisionSchema.parse(input);
  return transaction(async (c) => {
    const row = await lockChange(c, user, id);
    if (!(await mayDecide(c, user, row.carrier_id)))
      throw new HttpError(404, "NOT_FOUND");
    if (row.status !== "pending") throw new HttpError(409, "CHANGE_DECIDED");
    if (row.requested_by === user) throw new HttpError(409, "SAME_PERSON");
    if (data.decision === "reject") {
      await c.query(
        "UPDATE sensitive_changes SET status='rejected',decided_by=$2,decided_at=now(),decision_note=$3 WHERE id=$1",
        [id, user, data.note],
      );
      await emit(c, user, row.carrier_id, "change.rejected", {
        change_id: id,
        kind: row.kind,
      });
      return { id, status: "rejected" };
    }
    if (!data.verification) throw new HttpError(422, "VERIFICATION_REQUIRED");
    await stepUp(c, user, data.password, data.code);
    const outcome = await apply(c, row, user);
    if (outcome === "stale") {
      await c.query(
        "UPDATE sensitive_changes SET status='stale',decided_by=$2,decided_at=now(),decision_note=$3 WHERE id=$1",
        [id, user, "The record changed after this was requested; ask again."],
      );
      await emit(c, user, row.carrier_id, "change.stale", {
        change_id: id,
        kind: row.kind,
      });
      return { id, status: "stale" };
    }
    await c.query(
      `UPDATE sensitive_changes SET status='approved',decided_by=$2,decided_at=now(),decision_note=$3,
        verification=$4,effective_at=$5 WHERE id=$1`,
      [id, user, data.note, data.verification, outcome.effective_at],
    );
    await emit(c, user, row.carrier_id, "change.approved", {
      change_id: id,
      kind: row.kind,
      verification: data.verification,
    });
    return {
      id,
      status: "approved",
      effective_at: outcome.effective_at.toISOString(),
    };
  });
}

type Row = {
  id: string;
  carrier_id: string;
  kind: ChangeKind;
  subject_id: string | null;
  requested_by: string;
  proposed_value: Record<string, unknown>;
  current_value: Record<string, unknown>;
};

/** Applies an approved change. "stale" when the record moved on since the request. */
async function apply(
  c: PoolClient,
  row: Row,
  approver: string,
): Promise<"stale" | { effective_at: Date }> {
  if (row.kind === "payout_details") {
    const p = row.proposed_value as {
      payee_name: string;
      method: string;
      account_last4: string;
    };
    const effective = new Date(Date.now() + coolingHours() * 3600_000);
    await c.query(
      `INSERT INTO carrier_payout_details(carrier_id,payee_name,method,account_last4,effective_at,change_id)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (carrier_id) DO UPDATE SET payee_name=$2,method=$3,account_last4=$4,effective_at=$5,change_id=$6,updated_at=now()`,
      [
        row.carrier_id,
        p.payee_name,
        p.method,
        p.account_last4,
        effective,
        row.id,
      ],
    );
    return { effective_at: effective };
  }
  if (row.kind === "carrier_profile") {
    const cur = row.current_value as {
      name: string;
      contact_email: string;
      phone: string;
      usdot: string;
      mc_number: string;
    };
    const p = row.proposed_value as typeof cur;
    const now = await c.query(
      `SELECT c.name,p.contact_name,p.contact_email,p.phone,p.usdot,p.mc_number FROM carriers c
       JOIN carrier_profiles p ON p.carrier_id=c.id WHERE c.id=$1 FOR UPDATE OF p`,
      [row.carrier_id],
    );
    const n = now.rows[0];
    if (
      !n ||
      n.name !== cur.name ||
      n.contact_email !== cur.contact_email ||
      n.phone !== cur.phone ||
      n.usdot !== cur.usdot ||
      n.mc_number !== (cur.mc_number ?? "")
    )
      return "stale";
    await writeCompanyDetails(c, row.carrier_id, {
      name: p.name,
      contact_name: n.contact_name,
      contact_email: p.contact_email,
      phone: p.phone,
      usdot: p.usdot,
      mc_number: p.mc_number ?? "",
    });
    return { effective_at: new Date() };
  }
  if (row.kind === "contact_details") {
    const p = row.proposed_value as {
      email: string;
      phone: string;
      carrier_id: string | null;
    };
    const cur = row.current_value as {
      email: string;
      phone: string;
      carrier_id: string;
    };
    const now = await c.query(
      "SELECT email,phone,organization_id FROM contacts WHERE id=$1 AND carrier_id=$2 FOR UPDATE",
      [row.subject_id, row.carrier_id],
    );
    if (
      !now.rows[0] ||
      now.rows[0].email !== cur.email ||
      now.rows[0].phone !== cur.phone
    )
      return "stale";
    // Moving the contact to another carrier needs the approver to answer for
    // that carrier too, and it must stay in the same organization.
    if (p.carrier_id && p.carrier_id !== row.carrier_id) {
      const target = await c.query(
        "SELECT organization_id FROM carriers WHERE id=$1",
        [p.carrier_id],
      );
      if (
        target.rows[0]?.organization_id !== now.rows[0].organization_id ||
        !(await mayDecide(c, approver, p.carrier_id))
      )
        throw new HttpError(422, "TARGET_CARRIER_APPROVAL_REQUIRED");
    }
    // Consent belongs to a phone number; a new number needs consent recorded again.
    await c.query(
      `UPDATE contacts SET email=$2,phone=$3,carrier_id=$4,
        sms_consent_at=CASE WHEN phone=$3 THEN sms_consent_at END,
        sms_consent_by=CASE WHEN phone=$3 THEN sms_consent_by END,
        sms_consent_note=CASE WHEN phone=$3 THEN sms_consent_note ELSE '' END,
        version=version+1,updated_at=now() WHERE id=$1`,
      [row.subject_id, p.email, p.phone, p.carrier_id],
    );
    return { effective_at: new Date() };
  }
  // reroute: the stored edit, applied as the person who asked, if no stop moved meanwhile.
  const cur = row.current_value as { stops: { id: string; address: string }[] };
  const stops = await c.query(
    "SELECT id,address FROM load_stops WHERE load_id=$1",
    [row.subject_id],
  );
  for (const s of cur.stops) {
    if (stops.rows.find((x) => x.id === s.id)?.address !== s.address)
      return "stale";
  }
  const load = await c.query(
    "SELECT version,cancelled_at,stage FROM loads WHERE id=$1",
    [row.subject_id],
  );
  if (
    !load.rows[0] ||
    load.rows[0].cancelled_at ||
    load.rows[0].stage === "delivered"
  )
    return "stale";
  const edit = editSchema.parse({
    ...row.proposed_value,
    version: load.rows[0].version,
  });
  await editLoadIn(
    c,
    row.requested_by,
    row.subject_id as string,
    edit,
    undefined,
    true,
  );
  return { effective_at: new Date() };
}

/** Used by contact updates: parks a change to a carrier contact's phone, email or carrier link. */
export async function requestContactChange(
  c: PoolClient,
  user: string,
  contact: {
    id: string;
    carrier_id: string;
    name: string;
    email: string;
    phone: string;
  },
  next: { email: string; phone: string; carrier_id: string | null },
  reason: string,
) {
  const linkOnly = next.email === contact.email && next.phone === contact.phone;
  return requestChange(c, user, {
    carrierId: contact.carrier_id,
    kind: "contact_details",
    subjectId: contact.id,
    summary: linkOnly
      ? `Unlink or move ${contact.name} to another carrier`
      : `New phone, email or carrier link for ${contact.name}`,
    current: {
      email: contact.email,
      phone: contact.phone,
      carrier_id: contact.carrier_id,
    },
    proposed: next,
    reason,
  });
}
