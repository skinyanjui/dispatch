import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, hashNewPassword, HttpError } from "./auth";
import { insertReview } from "./documents";
import { requestChange } from "./change-control";
import { appOrigin, enqueueForEmail } from "./notifications";
import { acceptStaffInvite, inspectStaffInvite, isStaffInvite } from "./staff";

const text = (max: number) => z.string().trim().min(1).max(max);
const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());
const key = z.uuid();
const token = z.string().regex(/^[a-f0-9]{64}$/);
const company = z.object({
  name: text(160),
  contact_name: text(120),
  contact_email: email,
  phone: z.string().trim().max(40).default(""),
  usdot: z
    .string()
    .trim()
    .regex(/^\d{1,8}$|^$/)
    .default(""),
  // The carrier's MC (docket) number, checked against its USDOT number (ADR 0071).
  mc_number: z
    .string()
    .trim()
    .regex(/^\d{1,8}$|^$/)
    .default(""),
});
const timezone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  });

export async function carrierAccess(
  c: PoolClient,
  user: string,
  id: string,
  dispatcher = false,
  lock = false,
) {
  const { rows } = await c.query(
    `SELECT c.*,m.role FROM carriers c JOIN memberships m ON m.carrier_id=c.id AND m.user_id=$2
    WHERE c.id=$1 AND m.role IN ('dispatcher','carrier-manager') AND ($3::boolean=false OR m.role='dispatcher') ${lock ? "FOR UPDATE OF c" : ""}`,
    [id, user, dispatcher],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0];
}
export async function emit(
  c: PoolClient,
  user: string,
  id: string,
  type: string,
  payload: unknown = {},
) {
  const eventId = randomUUID();
  await c.query(
    "INSERT INTO onboarding_events(id,carrier_id,actor_id,type,payload) VALUES($1,$2,$3,$4,$5)",
    [eventId, id, user, type, JSON.stringify(payload)],
  );
  await c.query(
    "INSERT INTO outbox_events(id,onboarding_event_id,payload) VALUES($1,$2,$3)",
    [randomUUID(), eventId, JSON.stringify({ carrierId: id, type })],
  );
  await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    type,
    id,
  ]);
}
export async function once(
  c: PoolClient,
  user: string,
  idempotencyKey: string,
  kind: string,
  input: unknown,
  run: () => Promise<Record<string, unknown>>,
) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    user + ":onboarding:" + idempotencyKey,
  ]);
  const hash = digest(JSON.stringify({ kind, input }));
  const old = await c.query(
    "SELECT request_hash,response FROM onboarding_requests WHERE actor_id=$1 AND key=$2",
    [user, idempotencyKey],
  );
  if (old.rows[0]) {
    if (old.rows[0].request_hash !== hash)
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
    return old.rows[0].response;
  }
  const result = await run();
  await c.query("INSERT INTO onboarding_requests VALUES($1,$2,$3,$4)", [
    user,
    idempotencyKey,
    hash,
    JSON.stringify(result),
  ]);
  return result;
}
export async function createCarrier(user: string, input: unknown) {
  const data = company
    .extend({ organization_id: z.uuid(), key })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    // Organization admins, or (compatibility, ADR 0011) a dispatcher of any
    // carrier in the organization.
    const allowed = await c.query(
      `SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2
      UNION ALL SELECT 1 FROM carriers c JOIN memberships m ON m.carrier_id=c.id
        WHERE c.organization_id=$1 AND m.user_id=$2 AND m.role='dispatcher' LIMIT 1`,
      [data.organization_id, user],
    );
    if (!allowed.rowCount) throw new HttpError(404, "NOT_FOUND");
    return once(c, user, data.key, "carrier.create", data, async () => {
      const id = randomUUID();
      await c.query("INSERT INTO carriers VALUES($1,$2,$3)", [
        id,
        data.organization_id,
        data.name,
      ]);
      await c.query("INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)", [
        user,
        id,
      ]);
      await c.query(
        "INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone,usdot,mc_number) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          data.contact_name,
          data.contact_email,
          data.phone,
          data.usdot,
          data.mc_number,
        ],
      );
      await emit(c, user, id, "carrier.created");
      return { id };
    });
  });
}
export async function carrierSetup(user: string, id: string) {
  return transaction(async (c) => {
    const carrier = await carrierAccess(c, user, id);
    const profile = await c.query(
      "SELECT * FROM carrier_profiles WHERE carrier_id=$1",
      [id],
    );
    const agreements = await c.query(
      `SELECT agreement_ref,effective_at,expires_at,verified_at,
      (SELECT json_build_object('version_id',v.id,'filename',v.filename) FROM document_versions v WHERE v.id=document_version_id) document,
      (verified_at<=now() AND effective_at<=now() AND expires_at>now()) current
      FROM carrier_dispatch_authorizations WHERE carrier_id=$1 ORDER BY (verified_at<=now() AND effective_at<=now() AND expires_at>now()) DESC,expires_at DESC LIMIT 1`,
      [id],
    );
    const drivers = await c.query(
      `SELECT d.id,d.name,d.onboarding_status,d.phone,d.timezone,
      COALESCE(d.contact_email,(SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.driver_id=d.id LIMIT 1)) email
      FROM drivers d WHERE d.carrier_id=$1 AND d.onboarding_status<>'removed' ORDER BY d.name,d.id`,
      [id],
    );
    return {
      carrier,
      profile: profile.rows[0] ?? null,
      agreement: agreements.rows[0] ?? null,
      drivers: drivers.rows,
      can_verify: carrier.role === "dispatcher",
    };
  });
}
/** Writes the carrier's name and profile fields and revokes pending manager
 *  invitations addressed elsewhere. Shared by direct saves and approved changes. */
export async function writeCompanyDetails(
  c: PoolClient,
  id: string,
  d: {
    name: string;
    contact_name: string;
    contact_email: string;
    phone: string;
    usdot: string;
    mc_number: string;
  },
) {
  await c.query("UPDATE carriers SET name=$2 WHERE id=$1", [id, d.name]);
  await c.query(
    `INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone,usdot,mc_number,step) VALUES($1,$2,$3,$4,$5,$6,'team')
        ON CONFLICT(carrier_id) DO UPDATE SET contact_name=$2,contact_email=$3,phone=$4,usdot=$5,mc_number=$6,version=carrier_profiles.version+1,updated_at=now()`,
    [id, d.contact_name, d.contact_email, d.phone, d.usdot, d.mc_number],
  );
  await c.query(
    "UPDATE onboarding_invites SET revoked_at=now() WHERE carrier_id=$1 AND role='carrier-manager' AND email<>$2 AND accepted_at IS NULL AND revoked_at IS NULL",
    [id, d.contact_email],
  );
}

export async function saveCompany(user: string, id: string, input: unknown) {
  const data = company
    .extend({
      version: z.number().int().nonnegative(),
      key,
      // Why the carrier's name, email, phone or USDOT number is changing, once
      // setup is complete (ADR 0070).
      change_reason: z.string().trim().max(500).default(""),
    })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    const carrier = await carrierAccess(c, user, id, false, true);
    return once(
      c,
      user,
      data.key,
      "carrier.company",
      { id, ...data },
      async () => {
        const old = await c.query(
          "SELECT version,contact_name,contact_email,phone,usdot,mc_number,step FROM carrier_profiles WHERE carrier_id=$1",
          [id],
        );
        const was = old.rows[0];
        if ((was?.version ?? 0) !== data.version)
          throw new HttpError(409, "VERSION_CONFLICT");
        // Once a carrier is set up, its name, contact email, phone and USDOT
        // number are what invitations, calls and the registration monitor rest
        // on, so changing them waits for a second person. The contact's own
        // name applies now.
        if (
          was?.step === "complete" &&
          (data.name !== carrier.name ||
            data.contact_email !== was.contact_email ||
            data.phone !== was.phone ||
            data.usdot !== was.usdot ||
            data.mc_number !== was.mc_number)
        ) {
          if (!data.change_reason) throw new HttpError(422, "REASON_REQUIRED");
          const change = await requestChange(c, user, {
            carrierId: id,
            kind: "carrier_profile",
            subjectId: null,
            summary: `Change ${carrier.name}'s name, contact email, phone, USDOT or MC number`,
            current: {
              name: carrier.name,
              contact_email: was.contact_email,
              phone: was.phone,
              usdot: was.usdot,
              mc_number: was.mc_number,
            },
            proposed: {
              name: data.name,
              contact_email: data.contact_email,
              phone: data.phone,
              usdot: data.usdot,
              mc_number: data.mc_number,
            },
            reason: data.change_reason,
          });
          if (data.contact_name !== was.contact_name)
            await c.query(
              "UPDATE carrier_profiles SET contact_name=$2,version=version+1,updated_at=now() WHERE carrier_id=$1",
              [id, data.contact_name],
            );
          return { id, pending_approval: true, change_id: change };
        }
        await writeCompanyDetails(c, id, data);
        await emit(c, user, id, "carrier.details_saved");
        return { id };
      },
    );
  });
}
export async function saveAgreement(user: string, id: string, input: unknown) {
  const data = z
    .object({
      key,
      reference: text(300),
      effective_date: z.iso.date(),
      through_date: z.iso.date(),
      confirmed: z.literal(true),
      document_version_id: z.uuid().optional(),
    })
    .strict()
    .parse(input);
  const effective = new Date(data.effective_date + "T00:00:00Z");
  const expires = new Date(
    Date.parse(data.through_date + "T00:00:00Z") + 86400000,
  );
  if (expires <= effective) throw new HttpError(422, "INVALID_AGREEMENT_DATES");
  return transaction(async (c) => {
    await carrierAccess(c, user, id, true, true);
    return once(
      c,
      user,
      data.key,
      "carrier.agreement",
      { id, ...data },
      async () => {
        if (data.document_version_id) {
          // Only the latest uploaded agreement version for this carrier can be
          // verified; the review and authorization commit together.
          const file = await c.query(
            `SELECT v.id,v.carrier_id FROM document_versions v JOIN documents d ON d.id=v.document_id
            WHERE v.id=$1 AND v.carrier_id=$2 AND d.type='dispatch_agreement' AND d.load_id IS NULL
              AND v.version=(SELECT max(version) FROM document_versions WHERE document_id=d.id)`,
            [data.document_version_id, id],
          );
          if (!file.rows[0])
            throw new HttpError(422, "AGREEMENT_FILE_UNAVAILABLE");
          await insertReview(c, user, file.rows[0], "accepted", "");
        }
        await c.query(
          "INSERT INTO carrier_dispatch_authorizations(id,carrier_id,agreement_ref,verified_at,effective_at,expires_at,verified_by,document_version_id) VALUES($1,$2,$3,now(),$4,$5,$6,$7)",
          [
            randomUUID(),
            id,
            data.reference,
            effective,
            expires,
            user,
            data.document_version_id ?? null,
          ],
        );
        await c.query(
          "UPDATE carrier_profiles SET step='team',version=version+1,updated_at=now() WHERE carrier_id=$1",
          [id],
        );
        await emit(c, user, id, "carrier.agreement_verified", {
          reference: data.reference,
          effective_date: data.effective_date,
          through_date: data.through_date,
          document_version_id: data.document_version_id ?? null,
        });
        return { id };
      },
    );
  });
}
export async function completeSetup(user: string, id: string) {
  return transaction(async (c) => {
    await carrierAccess(c, user, id, false, true);
    const active = await c.query(
      "SELECT 1 FROM carrier_dispatch_authorizations WHERE carrier_id=$1 AND verified_at<=now() AND effective_at<=now() AND expires_at>now()",
      [id],
    );
    if (!active.rowCount)
      throw new HttpError(422, "CARRIER_AUTHORIZATION_REQUIRED");
    const result = await c.query(
      "UPDATE carrier_profiles SET step='complete',version=version+1,updated_at=now() WHERE carrier_id=$1 AND step<>'complete' RETURNING carrier_id",
      [id],
    );
    if (result.rowCount) await emit(c, user, id, "carrier.setup_completed");
    return { id };
  });
}
async function makeInvite(
  c: PoolClient,
  user: string,
  id: string,
  role: string,
  name: string,
  address: string,
  secret: string,
  driverId: string | null,
  origin?: string,
) {
  // Serializing on the carrier keeps reissues and driver creation deterministic.
  await c.query(
    "UPDATE onboarding_invites SET revoked_at=now() WHERE carrier_id=$1 AND role=$2 AND ($2='carrier-manager' OR email=$3) AND accepted_at IS NULL AND revoked_at IS NULL",
    [id, role, address],
  );
  const inviteId = randomUUID();
  const { rows } = await c.query(
    "INSERT INTO onboarding_invites(id,carrier_id,driver_id,role,email,name,token_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at",
    [inviteId, id, driverId, role, address, name, digest(secret), user],
  );
  const carrier = await c.query(
    "SELECT name,organization_id FROM carriers WHERE id=$1",
    [id],
  );
  // Queued in the same transaction as the invitation (outbox). The copied
  // link remains available as a fallback.
  await enqueueForEmail(c, address, {
    kind: "invitation",
    organization: carrier.rows[0].organization_id,
    dedupe: "invitation:" + inviteId,
    subject: `You're invited to ${carrier.rows[0].name} on Relay`,
    text: `Hello ${name},\n\nYou've been invited to join ${carrier.rows[0].name} on Relay as ${role === "driver" ? "a driver" : "the carrier manager"}.\n\nAccept your invitation (expires in 7 days):\n${appOrigin(origin)}/join#${secret}\n\nIf you weren't expecting this, you can ignore this email.`,
  });
  await emit(c, user, id, "invitation.created", {
    invite_id: inviteId,
    role,
    driver_id: driverId,
  });
  return {
    id: inviteId,
    driver_id: driverId,
    expires_at: rows[0].expires_at.toISOString(),
  };
}
export async function inviteManager(
  user: string,
  id: string,
  input: unknown,
  origin?: string,
) {
  const data = z.object({ key, token }).strict().parse(input);
  return transaction(async (c) => {
    await carrierAccess(c, user, id, true, true);
    return once(
      c,
      user,
      data.key,
      "invite.manager",
      { id, ...data },
      async () => {
        const profile = await c.query(
          "SELECT * FROM carrier_profiles WHERE carrier_id=$1",
          [id],
        );
        if (!profile.rows[0])
          throw new HttpError(422, "COMPANY_DETAILS_REQUIRED");
        return makeInvite(
          c,
          user,
          id,
          "carrier-manager",
          profile.rows[0].contact_name,
          profile.rows[0].contact_email,
          data.token,
          null,
          origin,
        );
      },
    );
  });
}
export async function inviteDriver(
  user: string,
  id: string,
  input: unknown,
  existingId?: string,
  origin?: string,
) {
  const data = z
    .object({ key, token, name: text(120).optional(), email: email.optional() })
    .strict()
    .parse(input);
  if (!existingId && (!data.name || !data.email))
    throw new HttpError(400, "DRIVER_DETAILS_REQUIRED");
  return transaction(async (c) => {
    await carrierAccess(c, user, id, false, true);
    return once(
      c,
      user,
      data.key,
      "invite.driver",
      { id, existingId, ...data },
      async () => {
        let driver;
        if (existingId) {
          const found = await c.query(
            "SELECT * FROM drivers WHERE id=$1 AND carrier_id=$2 AND onboarding_status='pending'",
            [existingId, id],
          );
          if (!found.rows[0]) throw new HttpError(404, "NOT_FOUND");
          driver = found.rows[0];
        } else {
          const duplicate = await c.query(
            "SELECT 1 FROM drivers d WHERE carrier_id=$1 AND (lower(contact_email)=$2 OR EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.driver_id=d.id AND u.email=$2))",
            [id, data.email],
          );
          if (duplicate.rowCount)
            throw new HttpError(409, "DRIVER_ALREADY_ADDED");
          const found = await c.query(
            "INSERT INTO drivers(id,carrier_id,name,onboarding_status,contact_email) VALUES($1,$2,$3,'pending',$4) RETURNING *",
            [randomUUID(), id, data.name, data.email],
          );
          driver = found.rows[0];
        }
        return makeInvite(
          c,
          user,
          id,
          "driver",
          driver.name,
          driver.contact_email,
          data.token,
          driver.id,
          origin,
        );
      },
    );
  });
}
export async function inspectInvite(
  input: unknown,
  user?: { id: string; email: string },
) {
  const data = z.object({ token }).strict().parse(input);
  const staff = await inspectStaffInvite(data.token, user);
  if (staff) return staff;
  const { rows } = await pool.query(
    `SELECT i.name,i.email,i.role,i.expires_at,c.name carrier_name,
    EXISTS(SELECT 1 FROM users u WHERE u.email=i.email) account_exists
    FROM onboarding_invites i JOIN carriers c ON c.id=i.carrier_id
    WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()`,
    [digest(data.token)],
  );
  if (!rows[0]) throw new HttpError(410, "INVITE_UNAVAILABLE");
  return { ...rows[0], signed_in: user?.email.toLowerCase() === rows[0].email };
}
export async function acceptInvite(
  input: unknown,
  user?: { id: string; email: string },
) {
  const data = z
    .object({
      token,
      name: text(120),
      password: z.string().min(12).max(256).optional(),
      phone: z.string().trim().max(40).default(""),
      timezone: timezone.default("UTC"),
    })
    .strict()
    .parse(input);
  if (await isStaffInvite(data.token)) return acceptStaffInvite(data, user);
  return transaction(async (c) => {
    const target = await c.query(
      "SELECT carrier_id FROM onboarding_invites WHERE token_hash=$1",
      [digest(data.token)],
    );
    if (!target.rows[0]) throw new HttpError(410, "INVITE_UNAVAILABLE");
    await c.query("SELECT 1 FROM carriers WHERE id=$1 FOR UPDATE", [
      target.rows[0].carrier_id,
    ]);
    const { rows } = await c.query(
      "SELECT * FROM onboarding_invites WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
      [digest(data.token)],
    );
    const invite = rows[0];
    if (!invite) throw new HttpError(410, "INVITE_UNAVAILABLE");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
      invite.email,
    ]);
    const existing = await c.query("SELECT id FROM users WHERE email=$1", [
      invite.email,
    ]);
    let userId = existing.rows[0]?.id;
    if (userId) {
      if (
        !user ||
        user.id !== userId ||
        user.email.toLowerCase() !== invite.email
      )
        throw new HttpError(401, "INVITE_SIGN_IN_REQUIRED");
    } else {
      if (!data.password) throw new HttpError(400, "PASSWORD_REQUIRED");
      userId = randomUUID();
      await c.query("INSERT INTO users VALUES($1,$2,$3,$4)", [
        userId,
        invite.email,
        await hashNewPassword(data.password),
        data.name,
      ]);
    }
    const membership = await c.query(
      "SELECT role,driver_id FROM memberships WHERE user_id=$1 AND carrier_id=$2",
      [userId, invite.carrier_id],
    );
    if (
      membership.rows[0] &&
      (membership.rows[0].role !== invite.role ||
        membership.rows[0].driver_id !== invite.driver_id)
    )
      throw new HttpError(409, "MEMBERSHIP_CONFLICT");
    await c.query(
      "INSERT INTO memberships VALUES($1,$2,$3,$4) ON CONFLICT(user_id,carrier_id) DO NOTHING",
      [userId, invite.carrier_id, invite.role, invite.driver_id],
    );
    if (invite.driver_id)
      await c.query(
        "UPDATE drivers SET name=$2,phone=$3,timezone=$4,onboarding_status='ready' WHERE id=$1 AND carrier_id=$5",
        [
          invite.driver_id,
          data.name,
          data.phone,
          data.timezone,
          invite.carrier_id,
        ],
      );
    await c.query(
      "UPDATE onboarding_invites SET accepted_at=now(),accepted_by=$2 WHERE id=$1",
      [invite.id, userId],
    );
    // The invitation was delivered to this address, so it is verified.
    await c.query(
      "UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1 AND email=$2",
      [userId, invite.email],
    );
    await emit(c, userId, invite.carrier_id, "invitation.accepted", {
      invite_id: invite.id,
      role: invite.role,
      driver_id: invite.driver_id,
    });
    const sessionToken = randomBytes(32).toString("hex");
    await c.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '12 hours')",
      [digest(sessionToken), userId],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'session.created',NULL,now())",
      [randomUUID(), userId],
    );
    return { sessionToken, role: invite.role };
  });
}
