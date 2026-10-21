import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, hashNewPassword, HttpError } from "./auth";
import { appOrigin, enqueueForEmail } from "./notifications";
import { once } from "./onboarding";

// Dispatcher and organization-admin invitations (ADR 0016).
const text = (max: number) => z.string().trim().min(1).max(max);
const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());
const token = z.string().regex(/^[a-f0-9]{64}$/);
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

async function orgRole(c: PoolClient, user: string, organization: string) {
  const { rows } = await c.query(
    "SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2",
    [organization, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0].role as "owner" | "admin";
}
async function organizationEvent(
  c: PoolClient,
  user: string,
  organization: string,
  type: string,
  payload: Record<string, unknown>,
) {
  await c.query(
    "INSERT INTO organization_events(id,organization_id,actor_id,type,payload) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), organization, user, type, JSON.stringify(payload)],
  );
  await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    user,
    type,
    organization,
  ]);
}

export const staffInviteSchema = z
  .object({
    key: z.uuid(),
    token,
    name: text(120),
    email,
    role: z.enum(["dispatcher", "admin"]),
    carrier_ids: z.array(z.uuid()).max(100).default([]),
  })
  .strict()
  .refine((d) => d.role === "admin" || d.carrier_ids.length > 0, {
    message: "Choose at least one carrier for a dispatcher",
    path: ["carrier_ids"],
  });

/**
 * Owners invite administrators; owners and administrators invite
 * dispatchers. A new invitation replaces earlier pending ones for the same
 * address. The private link is emailed through the notification outbox and
 * can also be copied.
 */
export async function inviteStaff(
  user: string,
  organization: string,
  input: unknown,
  origin?: string,
) {
  const data = staffInviteSchema.parse(input);
  return transaction(async (c) => {
    const role = await orgRole(c, user, organization);
    if (data.role === "admin" && role !== "owner")
      throw new HttpError(403, "OWNER_REQUIRED");
    return once(
      c,
      user,
      data.key,
      "staff.invite",
      { organization, ...data },
      async () => {
        const carriers = [...new Set(data.carrier_ids)];
        if (carriers.length) {
          const valid = await c.query(
            "SELECT count(*)::int n FROM carriers WHERE organization_id=$1 AND id=ANY($2::uuid[])",
            [organization, carriers],
          );
          if (valid.rows[0].n !== carriers.length)
            throw new HttpError(422, "CARRIER_NOT_IN_ORGANIZATION");
        }
        const existing = await c.query(
          `SELECT u.id,
          EXISTS(SELECT 1 FROM organization_members om WHERE om.organization_id=$1 AND om.user_id=u.id) is_admin,
          (SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id AND m.role='dispatcher' AND m.carrier_id=ANY($2::uuid[])) dispatching
        FROM users u WHERE u.email=$3`,
          [organization, carriers, data.email],
        );
        const found = existing.rows[0];
        if (
          found &&
          (data.role === "admin"
            ? found.is_admin
            : found.dispatching === carriers.length)
        )
          throw new HttpError(409, "ALREADY_MEMBER");
        await c.query(
          "UPDATE staff_invites SET revoked_at=now() WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
          [organization, data.email],
        );
        const id = randomUUID();
        const { rows } = await c.query(
          "INSERT INTO staff_invites(id,organization_id,email,name,role,carrier_ids,token_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at",
          [
            id,
            organization,
            data.email,
            data.name,
            data.role,
            carriers,
            digest(data.token),
            user,
          ],
        );
        const org = await c.query(
          "SELECT name FROM organizations WHERE id=$1",
          [organization],
        );
        await enqueueForEmail(c, data.email, {
          kind: "invitation",
          organization,
          dedupe: "staff-invitation:" + id,
          subject: `You're invited to ${org.rows[0].name} on Relay`,
          text: `Hello ${data.name},\n\nYou've been invited to join ${org.rows[0].name} on Relay as ${data.role === "admin" ? "an administrator" : "a dispatcher"}.\n\nAccept your invitation (expires in 7 days):\n${appOrigin(origin)}/join#${data.token}\n\nIf you weren't expecting this, you can ignore this email.`,
        });
        await organizationEvent(
          c,
          user,
          organization,
          "staff_invitation.created",
          {
            invite_id: id,
            role: data.role,
            carrier_ids: carriers,
          },
        );
        return { id, expires_at: rows[0].expires_at.toISOString() };
      },
    );
  });
}

export async function listStaffInvites(user: string, organization: string) {
  return transaction(async (c) => {
    await orgRole(c, user, organization);
    const { rows } = await c.query(
      `SELECT i.id,i.name,i.email,i.role,i.created_at,i.expires_at,u.name invited_by,
        (SELECT COALESCE(json_agg(c.name ORDER BY c.name),'[]') FROM carriers c WHERE c.id=ANY(i.carrier_ids)) carriers,
        (i.expires_at<=now()) expired
      FROM staff_invites i JOIN users u ON u.id=i.created_by
      WHERE i.organization_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC LIMIT 100`,
      [organization],
    );
    return { invites: rows };
  });
}

export async function revokeStaffInvite(
  user: string,
  organization: string,
  inviteId: string,
) {
  return transaction(async (c) => {
    const role = await orgRole(c, user, organization);
    const { rows } = await c.query(
      "SELECT role FROM staff_invites WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE",
      [inviteId, organization],
    );
    if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
    if (rows[0].role === "admin" && role !== "owner")
      throw new HttpError(403, "OWNER_REQUIRED");
    await c.query("UPDATE staff_invites SET revoked_at=now() WHERE id=$1", [
      inviteId,
    ]);
    await organizationEvent(c, user, organization, "staff_invitation.revoked", {
      invite_id: inviteId,
    });
    return { ok: true };
  });
}

/** Owners remove administrators; owners themselves cannot be removed here. */
export async function removeOrganizationAdmin(
  user: string,
  organization: string,
  input: unknown,
) {
  const data = z
    .object({ user_id: z.uuid(), reason: text(500) })
    .strict()
    .parse(input);
  return transaction(async (c) => {
    const role = await orgRole(c, user, organization);
    if (role !== "owner") throw new HttpError(403, "OWNER_REQUIRED");
    if (data.user_id === user) throw new HttpError(422, "CANNOT_REMOVE_SELF");
    const target = await c.query(
      "SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
      [organization, data.user_id],
    );
    if (!target.rows[0]) throw new HttpError(404, "NOT_FOUND");
    if (target.rows[0].role === "owner")
      throw new HttpError(422, "OWNER_NOT_REMOVABLE");
    await c.query(
      "DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2",
      [organization, data.user_id],
    );
    await organizationEvent(
      c,
      user,
      organization,
      "organization_admin.removed",
      {
        user_id: data.user_id,
        reason: data.reason,
      },
    );
    return { ok: true };
  });
}

// ---------- Join page: inspect and accept ----------

export async function isStaffInvite(secret: string) {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM staff_invites WHERE token_hash=$1",
    [digest(secret)],
  );
  return Boolean(rowCount);
}
export async function inspectStaffInvite(
  secret: string,
  user?: { id: string; email: string },
) {
  const { rows } = await pool.query(
    `SELECT i.name,i.email,i.role,i.expires_at,o.name carrier_name,true organization,
      EXISTS(SELECT 1 FROM users u WHERE u.email=i.email) account_exists
    FROM staff_invites i JOIN organizations o ON o.id=i.organization_id
    WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()`,
    [digest(secret)],
  );
  if (!rows[0]) return null;
  return { ...rows[0], signed_in: user?.email.toLowerCase() === rows[0].email };
}

export async function acceptStaffInvite(
  data: {
    token: string;
    name: string;
    password?: string;
    phone: string;
    timezone: string;
  },
  user?: { id: string; email: string },
) {
  void timezone;
  return transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM staff_invites WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
      [digest(data.token)],
    );
    const invite = rows[0];
    if (!invite) throw new HttpError(410, "INVITE_UNAVAILABLE");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
      invite.email,
    ]);
    const valid = await c.query(
      "SELECT count(*)::int n FROM carriers WHERE organization_id=$1 AND id=ANY($2::uuid[])",
      [invite.organization_id, invite.carrier_ids],
    );
    if (valid.rows[0].n !== invite.carrier_ids.length)
      throw new HttpError(410, "INVITE_UNAVAILABLE");
    const existing = await c.query("SELECT id FROM users WHERE email=$1", [
      invite.email,
    ]);
    let userId = existing.rows[0]?.id as string | undefined;
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
      await c.query(
        "INSERT INTO users(id,email,password_hash,name,phone) VALUES($1,$2,$3,$4,$5)",
        [
          userId,
          invite.email,
          await hashNewPassword(data.password),
          data.name,
          data.phone,
        ],
      );
    }
    for (const carrier of invite.carrier_ids as string[]) {
      const current = await c.query(
        "SELECT role FROM memberships WHERE user_id=$1 AND carrier_id=$2",
        [userId, carrier],
      );
      if (current.rows[0] && current.rows[0].role !== "dispatcher")
        throw new HttpError(409, "MEMBERSHIP_CONFLICT");
      await c.query(
        "INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL) ON CONFLICT(user_id,carrier_id) DO NOTHING",
        [userId, carrier],
      );
    }
    if (invite.role === "admin")
      await c.query(
        "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING",
        [invite.organization_id, userId],
      );
    if (data.phone && existing.rows[0])
      await c.query("UPDATE users SET phone=$2 WHERE id=$1 AND phone=''", [
        userId,
        data.phone,
      ]);
    await c.query(
      "UPDATE staff_invites SET accepted_at=now(),accepted_by=$2 WHERE id=$1",
      [invite.id, userId],
    );
    await c.query(
      "UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1 AND email=$2",
      [userId, invite.email],
    );
    await organizationEvent(
      c,
      userId,
      invite.organization_id,
      "staff_invitation.accepted",
      {
        invite_id: invite.id,
        role: invite.role,
      },
    );
    const sessionToken = randomBytes(32).toString("hex");
    await c.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '12 hours')",
      [digest(sessionToken), userId],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'session.created',NULL,now())",
      [randomUUID(), userId],
    );
    return { sessionToken, role: invite.role as string };
  });
}
