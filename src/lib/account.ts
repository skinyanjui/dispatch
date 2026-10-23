import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import {
  clientIp,
  consumeAttempt,
  createSession,
  digest,
  hashNewPassword,
  HttpError,
  verifyPassword,
} from "./auth";
import { appOrigin, enqueueForEmail } from "./notifications";
import { decrypt, encrypt, encryptionAvailable } from "./secrets";
import { newSecret, otpauthUri, verifyCode } from "./totp";
import { emit } from "./onboarding";

const password = z.string().min(12).max(256);
const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());
const secretToken = z.string().regex(/^[a-f0-9]{64}$/);
const audit = (actor: string | null, action: string, resource: string | null) =>
  pool.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    actor,
    action,
    resource,
  ]);

// ---------- Password reset ----------

/** Always succeeds from the caller's view so accounts cannot be enumerated. */
export async function requestPasswordReset(input: unknown, origin?: string) {
  const data = z.object({ email }).strict().parse(input);
  await consumeAttempt("reset:" + data.email, 3);
  await transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT id,name,email FROM users WHERE email=$1 FOR UPDATE",
      [data.email],
    );
    const user = rows[0];
    if (!user) return;
    await c.query(
      "UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='password_reset' AND used_at IS NULL",
      [user.id],
    );
    const token = randomBytes(32).toString("hex");
    await c.query(
      "INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,'password_reset',$3,now()+interval '1 hour')",
      [digest(token), user.id, user.email],
    );
    await enqueueForEmail(c, user.email, {
      kind: "password_reset",
      organization: null,
      dedupe: "password_reset:" + digest(token),
      subject: "Reset your Relay password",
      text: `Hello ${user.name},\n\nSomeone asked to reset the password for your Relay account. This link works once and expires in one hour:\n${appOrigin(origin)}/reset-password#${token}\n\nIf this wasn't you, ignore this email; your password stays the same.`,
    });
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user.id,
      "password_reset.requested",
      user.id,
    ]);
  });
  return { ok: true };
}

export async function completePasswordReset(input: unknown) {
  const data = z.object({ token: secretToken, password }).strict().parse(input);
  const hash = await hashNewPassword(data.password);
  return transaction(async (c) => {
    const { rows } = await c.query(
      `SELECT t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.purpose='password_reset' AND t.used_at IS NULL
        AND t.expires_at>now() AND t.email=u.email FOR UPDATE OF t`,
      [digest(data.token)],
    );
    if (!rows[0]) throw new HttpError(410, "TOKEN_UNAVAILABLE");
    const user = rows[0].user_id;
    // The link was emailed to the address on file, so using it also proves the
    // person controls that address.
    await c.query(
      "UPDATE users SET password_hash=$2,password_changed_at=now(),email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1",
      [user, hash],
    );
    // Every outstanding reset link and every session ends with the reset.
    await c.query(
      "UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='password_reset' AND used_at IS NULL",
      [user],
    );
    await c.query("DELETE FROM sessions WHERE user_id=$1", [user]);
    await c.query("DELETE FROM mfa_challenges WHERE user_id=$1", [user]);
    await c.query("DELETE FROM login_attempts WHERE identity_hash=$1", [
      digest("mfa-login:" + user),
    ]);
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "password_reset.completed",
      user,
    ]);
    return { ok: true };
  });
}

export async function changePassword(
  user: string,
  input: unknown,
  currentSessionToken: string,
) {
  const data = z
    .object({
      current_password: z.string().min(1).max(256),
      new_password: password,
    })
    .strict()
    .parse(input);
  await consumeAttempt("change-password:" + user, 5);
  const { rows } = await pool.query(
    "SELECT password_hash FROM users WHERE id=$1",
    [user],
  );
  if (!(await verifyPassword(data.current_password, rows[0].password_hash)))
    throw new HttpError(403, "INVALID_CREDENTIALS");
  const hash = await hashNewPassword(data.new_password);
  await transaction(async (c) => {
    await c.query(
      "UPDATE users SET password_hash=$2,password_changed_at=now() WHERE id=$1",
      [user, hash],
    );
    await c.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [
      user,
      digest(currentSessionToken),
    ]);
  });
  await audit(user, "password.changed", user);
  return { ok: true };
}

// ---------- Email verification ----------

export async function requestEmailVerification(user: string, origin?: string) {
  await consumeAttempt("verify-email:" + user, 3);
  return transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT name,email,email_verified_at FROM users WHERE id=$1 FOR UPDATE",
      [user],
    );
    if (rows[0].email_verified_at) return { already_verified: true };
    await c.query(
      "UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='email_verification' AND used_at IS NULL",
      [user],
    );
    const token = randomBytes(32).toString("hex");
    await c.query(
      "INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,'email_verification',$3,now()+interval '24 hours')",
      [digest(token), user, rows[0].email],
    );
    await enqueueForEmail(c, rows[0].email, {
      kind: "email_verification",
      organization: null,
      dedupe: "email_verification:" + digest(token),
      subject: "Confirm your email for Relay",
      text: `Hello ${rows[0].name},\n\nConfirm this email address for your Relay account (link expires in 24 hours):\n${appOrigin(origin)}/verify-email#${token}`,
    });
    return { already_verified: false };
  });
}

export async function completeEmailVerification(input: unknown) {
  const data = z.object({ token: secretToken }).strict().parse(input);
  return transaction(async (c) => {
    // The token is bound to the address it was sent to.
    const { rows } = await c.query(
      `SELECT t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.purpose='email_verification' AND t.used_at IS NULL
        AND t.expires_at>now() AND t.email=u.email FOR UPDATE OF t`,
      [digest(data.token)],
    );
    if (!rows[0]) throw new HttpError(410, "TOKEN_UNAVAILABLE");
    await c.query(
      "UPDATE account_tokens SET used_at=now() WHERE token_hash=$1",
      [digest(data.token)],
    );
    await c.query(
      "UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1",
      [rows[0].user_id],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      rows[0].user_id,
      "email.verified",
      rows[0].user_id,
    ]);
    return { ok: true };
  });
}

// ---------- MFA ----------

const recoveryCode = () =>
  randomBytes(5)
    .toString("hex")
    .replace(/^(.{5})/, "$1-");
const normalizeRecovery = (v: string) =>
  v.trim().toLowerCase().replace(/\s/g, "");

export async function mfaSetup(user: string) {
  if (!encryptionAvailable()) throw new HttpError(503, "MFA_UNAVAILABLE");
  const { rows } = await pool.query(
    "SELECT email,mfa_enabled_at FROM users WHERE id=$1",
    [user],
  );
  if (rows[0].mfa_enabled_at) throw new HttpError(409, "MFA_ALREADY_ENABLED");
  const secret = newSecret();
  await pool.query(
    "UPDATE users SET mfa_secret_ciphertext=$2 WHERE id=$1 AND mfa_enabled_at IS NULL",
    [user, encrypt(secret)],
  );
  return { secret, otpauth_uri: otpauthUri(secret, rows[0].email) };
}

export async function mfaEnable(user: string, input: unknown) {
  const data = z.object({ code: z.string().trim() }).strict().parse(input);
  await consumeAttempt("mfa-enable:" + user, 5);
  return transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT mfa_secret_ciphertext,mfa_enabled_at FROM users WHERE id=$1 FOR UPDATE",
      [user],
    );
    if (rows[0].mfa_enabled_at) throw new HttpError(409, "MFA_ALREADY_ENABLED");
    if (!rows[0].mfa_secret_ciphertext)
      throw new HttpError(422, "MFA_SETUP_REQUIRED");
    const step = verifyCode(
      decrypt(rows[0].mfa_secret_ciphertext),
      data.code,
      Date.now(),
      null,
    );
    if (step === null) throw new HttpError(422, "INVALID_MFA_CODE");
    await c.query(
      "UPDATE users SET mfa_enabled_at=now(),mfa_last_step=$2 WHERE id=$1",
      [user, step],
    );
    await c.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [user]);
    const codes = Array.from({ length: 10 }, recoveryCode);
    for (const code of codes)
      await c.query(
        "INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)",
        [user, digest(normalizeRecovery(code))],
      );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'mfa.enabled',$3,now())",
      [randomUUID(), user, user],
    );
    return { recovery_codes: codes };
  });
}

/** Accepts a fresh TOTP code or an unused recovery code; consumes either. */
async function consumeSecondFactor(
  c: import("pg").PoolClient,
  user: string,
  code: string,
) {
  const { rows } = await c.query(
    "SELECT mfa_secret_ciphertext,mfa_last_step FROM users WHERE id=$1 FOR UPDATE",
    [user],
  );
  const step = verifyCode(
    decrypt(rows[0].mfa_secret_ciphertext),
    code.trim(),
    Date.now(),
    rows[0].mfa_last_step === null ? null : Number(rows[0].mfa_last_step),
  );
  if (step !== null) {
    await c.query("UPDATE users SET mfa_last_step=$2 WHERE id=$1", [
      user,
      step,
    ]);
    return "totp";
  }
  const recovery = await c.query(
    "UPDATE mfa_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING 1",
    [user, digest(normalizeRecovery(code))],
  );
  return recovery.rowCount ? "recovery" : null;
}

export async function mfaDisable(user: string, input: unknown) {
  const data = z
    .object({ password: z.string().min(1).max(256), code: z.string().max(40) })
    .strict()
    .parse(input);
  await consumeAttempt("mfa-disable:" + user, 5);
  const { rows } = await pool.query(
    "SELECT password_hash,mfa_enabled_at FROM users WHERE id=$1",
    [user],
  );
  if (!rows[0].mfa_enabled_at) throw new HttpError(422, "MFA_NOT_ENABLED");
  if (!(await verifyPassword(data.password, rows[0].password_hash)))
    throw new HttpError(403, "INVALID_CREDENTIALS");
  return transaction(async (c) => {
    if (!(await consumeSecondFactor(c, user, data.code)))
      throw new HttpError(422, "INVALID_MFA_CODE");
    await c.query(
      "UPDATE users SET mfa_enabled_at=NULL,mfa_secret_ciphertext=NULL,mfa_last_step=NULL WHERE id=$1",
      [user],
    );
    await c.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [user]);
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'mfa.disabled',$3,now())",
      [randomUUID(), user, user],
    );
    return { ok: true };
  });
}

export async function completeMfaLogin(input: unknown, request?: Request) {
  const data = z
    .object({ challenge: secretToken, code: z.string().max(40) })
    .strict()
    .parse(input);
  // A correct password mints a fresh challenge (and five guesses) each time, so
  // the guess budget must follow the person, not the challenge. Each address
  // gets 10 tries per 15 minutes, so someone who knows the password cannot
  // lock the owner out from elsewhere; an account-wide ceiling of 30 an hour
  // bounds guessing spread over many addresses, and a password reset lifts it.
  const owner = await pool.query(
    "SELECT user_id FROM mfa_challenges WHERE token_hash=$1 AND expires_at>now()",
    [digest(data.challenge)],
  );
  if (owner.rows[0]) {
    const id = owner.rows[0].user_id as string;
    await consumeAttempt(
      "mfa-login:" + id + ":" + (request ? clientIp(request) : "unknown"),
      10,
      900,
    );
    await consumeAttempt("mfa-login:" + id, 30, 3600);
  }
  const verified = await transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM mfa_challenges WHERE token_hash=$1 AND expires_at>now() FOR UPDATE",
      [digest(data.challenge)],
    );
    const challenge = rows[0];
    if (!challenge) throw new HttpError(401, "MFA_CHALLENGE_EXPIRED");
    if (challenge.attempts >= 5) {
      await c.query("DELETE FROM mfa_challenges WHERE token_hash=$1", [
        challenge.token_hash,
      ]);
      throw new HttpError(429, "TRY_AGAIN_LATER");
    }
    const factor = await consumeSecondFactor(c, challenge.user_id, data.code);
    if (!factor) {
      await c.query(
        "UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1",
        [challenge.token_hash],
      );
      return null;
    }
    await c.query("DELETE FROM mfa_challenges WHERE token_hash=$1", [
      challenge.token_hash,
    ]);
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      challenge.user_id,
      "mfa.verified." + factor,
      challenge.user_id,
    ]);
    return {
      userId: challenge.user_id as string,
      remember: challenge.remember as boolean,
    };
  });
  // The failed-attempt count must commit, so reject outside the transaction.
  if (!verified) throw new HttpError(401, "INVALID_MFA_CODE");
  return {
    token: await createSession(verified.userId, verified.remember),
    remember: verified.remember,
  };
}

// ---------- Account summary ----------

export async function accountSummary(user: string) {
  const { rows } = await pool.query(
    `SELECT u.name,u.email,u.phone,u.sms_opt_in_at IS NOT NULL sms_opt_in,u.email_verified_at IS NOT NULL email_verified,u.mfa_enabled_at IS NOT NULL mfa_enabled,
      (SELECT count(*)::int FROM mfa_recovery_codes WHERE user_id=u.id AND used_at IS NULL) recovery_codes_remaining,
      (SELECT COALESCE(json_agg(json_build_object('id',o.id,'name',o.name,'role',om.role) ORDER BY o.name),'[]')
        FROM organization_members om JOIN organizations o ON o.id=om.organization_id WHERE om.user_id=u.id) organizations
    FROM users u WHERE u.id=$1`,
    [user],
  );
  return { ...rows[0], mfa_available: encryptionAvailable() };
}

export async function saveProfile(user: string, input: unknown) {
  const data = z
    .object({
      name: z.string().trim().min(1).max(120),
      phone: z.string().trim().max(40).default(""),
      sms_opt_in: z.boolean().optional(),
    })
    .strict()
    .parse(input);
  await pool.query(
    `UPDATE users SET name=$2,phone=$3,
      sms_opt_in_at=CASE WHEN $4::boolean IS NULL THEN sms_opt_in_at
        WHEN $4 THEN COALESCE(sms_opt_in_at,now()) END
    WHERE id=$1`,
    [user, data.name, data.phone, data.sms_opt_in ?? null],
  );
  await audit(user, "profile.updated", user);
  return { ok: true };
}

// ---------- Organization setup and team ----------

export async function orgAdmin(
  c: import("pg").PoolClient,
  user: string,
  org: string,
) {
  const { rows } = await c.query(
    "SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2",
    [org, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return rows[0].role as "owner" | "admin";
}

export async function organization(user: string, org: string) {
  return transaction(async (c) => {
    const role = await orgAdmin(c, user, org);
    const base = await c.query(
      `SELECT o.id,o.name,COALESCE(p.legal_name,'') legal_name,COALESCE(p.billing_email,'') billing_email,
        COALESCE(p.phone,'') phone,COALESCE(p.address,'') address,COALESCE(p.timezone,'America/Chicago') timezone,
        COALESCE(p.version,0) version
      FROM organizations o LEFT JOIN organization_profiles p ON p.organization_id=o.id WHERE o.id=$1`,
      [org],
    );
    const admins = await c.query(
      `SELECT u.id,u.name,u.email,om.role,u.email_verified_at IS NOT NULL email_verified,u.mfa_enabled_at IS NOT NULL mfa_enabled
      FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=$1 ORDER BY u.name`,
      [org],
    );
    const team = await c.query(
      `SELECT c.id carrier_id,c.name carrier_name,m.role,m.driver_id,u.id user_id,u.name,u.email,
        u.email_verified_at IS NOT NULL email_verified,u.mfa_enabled_at IS NOT NULL mfa_enabled
      FROM carriers c JOIN memberships m ON m.carrier_id=c.id JOIN users u ON u.id=m.user_id
      WHERE c.organization_id=$1 ORDER BY c.name,c.id,
        CASE m.role WHEN 'dispatcher' THEN 0 WHEN 'carrier-manager' THEN 1 ELSE 2 END,u.name`,
      [org],
    );
    return { ...base.rows[0], role, admins: admins.rows, team: team.rows };
  });
}

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
export const organizationSchema = z
  .object({
    version: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(160),
    legal_name: z.string().trim().max(200).default(""),
    billing_email: z.union([email, z.literal("")]).default(""),
    phone: z.string().trim().max(40).default(""),
    address: z.string().trim().max(500).default(""),
    timezone,
  })
  .strict();

export async function saveOrganization(
  user: string,
  org: string,
  input: unknown,
) {
  const data = organizationSchema.parse(input);
  return transaction(async (c) => {
    await orgAdmin(c, user, org);
    await c.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [org]);
    const current = await c.query(
      "SELECT version FROM organization_profiles WHERE organization_id=$1",
      [org],
    );
    if ((current.rows[0]?.version ?? 0) !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    await c.query("UPDATE organizations SET name=$2 WHERE id=$1", [
      org,
      data.name,
    ]);
    await c.query(
      `INSERT INTO organization_profiles(organization_id,legal_name,billing_email,phone,address,timezone)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id) DO UPDATE SET legal_name=$2,billing_email=$3,
      phone=$4,address=$5,timezone=$6,version=organization_profiles.version+1,updated_at=now()`,
      [
        org,
        data.legal_name,
        data.billing_email,
        data.phone,
        data.address,
        data.timezone,
      ],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'organization.updated',$3,now())",
      [randomUUID(), user, org],
    );
    return { id: org, version: data.version + 1 };
  });
}

export const removalSchema = z
  .object({
    user_id: z.uuid().optional(),
    driver_id: z.uuid().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((d) => Boolean(d.user_id) !== Boolean(d.driver_id), {
    message: "Name exactly one person to remove",
  });

/**
 * Removes a person's access to one carrier. Dispatchers (or organization
 * admins) may remove managers, drivers and other dispatchers; carrier
 * managers may remove drivers. Nobody removes themselves, and each carrier
 * keeps at least one dispatcher. Drivers on undelivered loads must be
 * reassigned first. History (loads, events, documents) is kept.
 */
export async function removeTeamMember(
  user: string,
  carrierId: string,
  input: unknown,
) {
  const data = removalSchema.parse(input);
  return transaction(async (c) => {
    const carrier = await c.query(
      "SELECT id,organization_id FROM carriers WHERE id=$1 FOR UPDATE",
      [carrierId],
    );
    if (!carrier.rows[0]) throw new HttpError(404, "NOT_FOUND");
    const actor = await c.query(
      `SELECT (SELECT role FROM memberships WHERE user_id=$1 AND carrier_id=$2) role,
        EXISTS(SELECT 1 FROM organization_members WHERE organization_id=$3 AND user_id=$1) org_admin`,
      [user, carrierId, carrier.rows[0].organization_id],
    );
    // Organization admins manage every carrier in their organization.
    const actorRole: string | undefined = actor.rows[0].org_admin
      ? "dispatcher"
      : (actor.rows[0].role ?? undefined);
    if (!actorRole || actorRole === "driver")
      throw new HttpError(404, "NOT_FOUND");
    let target: {
      user_id: string | null;
      driver_id: string | null;
      role: string;
    };
    if (data.driver_id) {
      const driver = await c.query(
        "SELECT id FROM drivers WHERE id=$1 AND carrier_id=$2 AND onboarding_status<>'removed' FOR UPDATE",
        [data.driver_id, carrierId],
      );
      if (!driver.rows[0]) throw new HttpError(404, "NOT_FOUND");
      const account = await c.query(
        "SELECT user_id FROM memberships WHERE carrier_id=$1 AND driver_id=$2",
        [carrierId, data.driver_id],
      );
      target = {
        user_id: account.rows[0]?.user_id ?? null,
        driver_id: data.driver_id,
        role: "driver",
      };
    } else {
      const m = await c.query(
        "SELECT role,driver_id FROM memberships WHERE carrier_id=$1 AND user_id=$2",
        [carrierId, data.user_id],
      );
      if (!m.rows[0]) throw new HttpError(404, "NOT_FOUND");
      target = {
        user_id: data.user_id!,
        driver_id: m.rows[0].driver_id,
        role: m.rows[0].role,
      };
    }
    if (target.user_id === user) throw new HttpError(422, "CANNOT_REMOVE_SELF");
    if (target.role !== "driver" && actorRole !== "dispatcher")
      throw new HttpError(403, "ROLE_NOT_PERMITTED");
    if (target.role === "dispatcher") {
      const others = await c.query(
        "SELECT count(*)::int n FROM memberships WHERE carrier_id=$1 AND role='dispatcher' AND user_id<>$2",
        [carrierId, target.user_id],
      );
      if (!others.rows[0].n) throw new HttpError(422, "LAST_DISPATCHER");
    }
    if (target.driver_id) {
      const active = await c.query(
        "SELECT 1 FROM load_assignments a JOIN loads l ON l.id=a.load_id WHERE a.driver_id=$1 AND l.stage<>'delivered' AND l.cancelled_at IS NULL LIMIT 1",
        [target.driver_id],
      );
      if (active.rowCount) throw new HttpError(422, "DRIVER_HAS_ACTIVE_LOADS");
      await c.query(
        "UPDATE drivers SET onboarding_status='removed' WHERE id=$1",
        [target.driver_id],
      );
      await c.query(
        "UPDATE onboarding_invites SET revoked_at=now() WHERE driver_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL",
        [target.driver_id],
      );
    }
    if (target.user_id) {
      await c.query(
        "DELETE FROM memberships WHERE carrier_id=$1 AND user_id=$2",
        [carrierId, target.user_id],
      );
      // Open exceptions they owned for this carrier go back to the queue.
      const released = await c.query(
        `UPDATE load_exceptions SET owner_id=NULL,version=version+1,updated_at=now()
        WHERE carrier_id=$1 AND owner_id=$2 AND status<>'resolved' RETURNING id,load_id`,
        [carrierId, target.user_id],
      );
      for (const r of released.rows) {
        const eventId = randomUUID();
        await c.query(
          "INSERT INTO load_events(id,load_id,carrier_id,actor_id,type,payload) VALUES($1,$2,$3,$4,'exception.assigned',$5)",
          [
            eventId,
            r.load_id,
            carrierId,
            user,
            JSON.stringify({
              exception_id: r.id,
              owner_id: null,
              reason: "member_removed",
            }),
          ],
        );
        await c.query(
          "INSERT INTO outbox_events(id,event_id,payload) VALUES($1,$2,$3)",
          [
            randomUUID(),
            eventId,
            JSON.stringify({ loadId: r.load_id, type: "exception.assigned" }),
          ],
        );
      }
      // Without any remaining access, existing sessions end immediately.
      const remaining = await c.query(
        "SELECT 1 FROM memberships WHERE user_id=$1 UNION SELECT 1 FROM organization_members WHERE user_id=$1 LIMIT 1",
        [target.user_id],
      );
      if (!remaining.rowCount)
        await c.query("DELETE FROM sessions WHERE user_id=$1", [
          target.user_id,
        ]);
    }
    await c.query(
      "INSERT INTO membership_removals(id,carrier_id,user_id,driver_id,role,reason,removed_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        carrierId,
        target.user_id,
        target.driver_id,
        target.role,
        data.reason,
        user,
      ],
    );
    await emit(c, user, carrierId, "member.removed", {
      user_id: target.user_id,
      driver_id: target.driver_id,
      role: target.role,
    });
    return { ok: true };
  });
}

/**
 * With RELAY_REQUIRE_MFA=true, people who run dispatch operations (organization
 * members and carrier managers or dispatchers) must have two-step verification
 * on before they can use anything but their account page. Drivers are not
 * required. It stays off when the server cannot store second factors, so a
 * missing RELAY_DATA_KEY never locks everyone out.
 */
export async function mfaRequired(user: string) {
  if (process.env.RELAY_REQUIRE_MFA !== "true" || !encryptionAvailable())
    return false;
  const { rows } = await pool.query(
    `SELECT u.mfa_enabled_at IS NULL AND (
      EXISTS(SELECT 1 FROM organization_members WHERE user_id=u.id)
      OR EXISTS(SELECT 1 FROM memberships WHERE user_id=u.id AND role<>'driver')) required
    FROM users u WHERE u.id=$1`,
    [user],
  );
  return rows[0]?.required === true;
}
