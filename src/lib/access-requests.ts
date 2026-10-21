import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { consumeAttempt, digest, hashNewPassword, HttpError } from "./auth";
import { appOrigin, enqueueForEmail } from "./notifications";
import { legalVersion } from "./legal";

// Request access (ADR 0034). There is no open sign-up: a request stores a few
// details and nothing else. It creates no account, organization, session or
// message. An operator approves or declines it; approval creates the
// organization and gives its first owner a private link to set a password.

const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());
const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).default("");

export const requestSchema = z
  .object({
    name: text(120),
    email,
    company: text(160),
    phone: optional(40),
    note: optional(500),
    terms_accepted: z.literal(true),
    terms_version: z.string().max(40),
    /** A field people never see: any value means a bot filled it in. */
    website: z.string().max(200).default(""),
  })
  .strict();

/**
 * The public form. It always answers the same way, so it cannot be used to
 * find out who already has an account or a pending request, and it sends
 * nothing: a confirmation email would let anyone mail any address.
 */
export async function submitAccessRequest(input: unknown) {
  const data = requestSchema.parse(input);
  if (data.terms_version !== legalVersion)
    throw new HttpError(409, "TERMS_CHANGED");
  await consumeAttempt("access-request:" + data.email, 3);
  await consumeAttempt("access-request:all", 60);
  if (data.website) return { ok: true };
  await pool.query(
    `INSERT INTO access_requests(id,email,name,company,phone,note,source,terms_version,terms_accepted_at)
    SELECT $1,$2,$3,$4,$5,$6,'form',$7,now()
    WHERE NOT EXISTS(SELECT 1 FROM users WHERE email=$2)
    ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      data.email,
      data.name,
      data.company,
      data.phone,
      data.note,
      data.terms_version,
    ],
  );
  return { ok: true };
}

/**
 * A person signed in with Google or Apple but has no Relay account: their
 * verified email becomes a pending request, nothing more. Repeats are no-ops.
 */
export async function requestFromProvider(
  source: "google" | "apple",
  person: { email: string; name: string },
) {
  const address = email.parse(person.email);
  await pool.query(
    `INSERT INTO access_requests(id,email,name,company,source,email_verified)
    SELECT $1,$2,$3,'(not given)',$4,true
    WHERE NOT EXISTS(SELECT 1 FROM users WHERE email=$2)
    ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      address,
      person.name.trim().slice(0, 120) || address,
      source,
    ],
  );
}

export type AccessRequestRow = {
  id: string;
  email: string;
  name: string;
  company: string;
  phone: string;
  note: string;
  source: string;
  email_verified: boolean;
  status: string;
  created_at: string;
};
export async function listAccessRequests(status = "pending") {
  const { rows } = await pool.query(
    `SELECT id,email,name,company,phone,note,source,email_verified,status,created_at
    FROM access_requests WHERE status=$1 ORDER BY created_at LIMIT 200`,
    [z.enum(["pending", "approved", "declined"]).parse(status)],
  );
  return rows as AccessRequestRow[];
}

const audit = (
  c: { query: (s: string, v: unknown[]) => Promise<unknown> },
  action: string,
  resource: string,
  actor: string | null = null,
) =>
  c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    actor,
    action,
    resource,
  ]);

/**
 * Approves a request: creates the organization and its owner. A new person
 * gets an account nobody can sign in to yet, plus a private link (valid seven
 * days) to choose a password; the link is returned to the operator and also
 * queued as an email, which is only delivered if a transport is configured.
 * An existing account keeps its password and becomes the owner. Repeating the
 * call returns the earlier result without a link.
 */
export async function approveAccessRequest(id: string, origin?: string) {
  const requestId = z.uuid().parse(id);
  return transaction(async (c) => {
    const found = await c.query(
      "SELECT * FROM access_requests WHERE id=$1 FOR UPDATE",
      [requestId],
    );
    const r = found.rows[0];
    if (!r) throw new HttpError(404, "NOT_FOUND");
    if (r.status === "approved")
      return {
        organization_id: r.organization_id as string,
        user_id: r.user_id as string,
        setup_link: null as string | null,
        created_user: false,
        repeated: true,
      };
    if (r.status === "declined") throw new HttpError(409, "ALREADY_DECLINED");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "org-bootstrap:" + r.email,
    ]);
    let user = (await c.query("SELECT id FROM users WHERE email=$1", [r.email]))
      .rows[0]?.id as string | undefined;
    const createdUser = !user;
    if (!user) {
      user = randomUUID();
      // A random password nobody knows: the person sets theirs from the link.
      await c.query(
        "INSERT INTO users(id,email,password_hash,name,email_verified_at) VALUES($1,$2,$3,$4,$5)",
        [
          user,
          r.email,
          await hashNewPassword(randomBytes(32).toString("hex")),
          r.name,
          r.email_verified ? new Date() : null,
        ],
      );
    }
    const organization = randomUUID();
    await c.query("INSERT INTO organizations VALUES($1,$2)", [
      organization,
      r.company,
    ]);
    await c.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [organization, user],
    );
    await c.query(
      `UPDATE access_requests SET status='approved',decided_at=now(),organization_id=$2,user_id=$3 WHERE id=$1`,
      [requestId, organization, user],
    );
    let link: string | null = null;
    if (createdUser) {
      const token = randomBytes(32).toString("hex");
      await c.query(
        "INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,'password_reset',$3,now()+interval '7 days')",
        [digest(token), user, r.email],
      );
      link = `${appOrigin(origin)}/reset-password#${token}`;
      await enqueueForEmail(c, r.email, {
        kind: "invitation",
        organization,
        dedupe: "access-approved:" + requestId,
        subject: "Your Relay workspace is ready",
        text: `Hello ${r.name},\n\nYour request for access was approved and the workspace "${r.company}" is ready.\n\nChoose your password (this link works once and expires in 7 days):\n${link}\n\nIf you did not ask for access, ignore this email.`,
      });
    }
    await audit(c, "organization.created", organization, user);
    await audit(c, "access.approved", requestId);
    return {
      organization_id: organization,
      user_id: user,
      setup_link: link,
      created_user: createdUser,
      repeated: false,
    };
  });
}

export async function declineAccessRequest(id: string, reason = "") {
  const requestId = z.uuid().parse(id);
  const note = z.string().trim().max(300).parse(reason);
  return transaction(async (c) => {
    const found = await c.query(
      "SELECT status FROM access_requests WHERE id=$1 FOR UPDATE",
      [requestId],
    );
    if (!found.rows[0]) throw new HttpError(404, "NOT_FOUND");
    if (found.rows[0].status === "approved")
      throw new HttpError(409, "ALREADY_APPROVED");
    if (found.rows[0].status === "pending") {
      await c.query(
        "UPDATE access_requests SET status='declined',decided_at=now(),decision_note=$2 WHERE id=$1",
        [requestId, note],
      );
      await audit(c, "access.declined", requestId);
    }
    return { ok: true };
  });
}
