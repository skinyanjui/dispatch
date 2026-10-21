import {
  randomBytes,
  scrypt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { pool } from "./db";
import { promisify } from "node:util";
const deriveKey = promisify(scrypt);
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = (await deriveKey(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function consumeLoginAttempt(email: string) {
  const key = digest(email.trim().toLowerCase());
  await pool.query("DELETE FROM login_attempts WHERE resets_at < now()");
  const result = await pool.query(
    `INSERT INTO login_attempts VALUES($1,1,now()+interval '1 minute')
    ON CONFLICT(identity_hash) DO UPDATE SET
    attempts=CASE WHEN login_attempts.resets_at<=now() THEN 1 ELSE login_attempts.attempts+1 END,
    resets_at=CASE WHEN login_attempts.resets_at<=now() THEN now()+interval '1 minute' ELSE login_attempts.resets_at END
    RETURNING attempts`,
    [key],
  );
  if (result.rows[0].attempts > 8) throw new HttpError(429, "TRY_AGAIN_LATER");
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function session(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("relay_session="))
    ?.slice(14);
  if (!token) throw new HttpError(401, "AUTH_REQUIRED");
  const { rows } = await pool.query(
    "SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [digest(token)],
  );
  if (!rows[0]) throw new HttpError(401, "SESSION_EXPIRED");
  return rows[0] as { id: string; name: string; email: string };
}
export function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const expected =
    process.env.APP_ORIGIN ||
    `${url.protocol}//${request.headers.get("host") || url.host}`;
  if (request.headers.get("origin") !== expected)
    throw new HttpError(403, "ORIGIN_REJECTED");
}
export async function login(email: string, password: string) {
  await consumeLoginAttempt(email);
  const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [
    email.trim().toLowerCase(),
  ]);
  const fallback = "00000000000000000000000000000000:" + "00".repeat(64);
  const valid = await verifyPassword(
    password,
    rows[0]?.password_hash ?? fallback,
  );
  if (!rows[0] || !valid) throw new HttpError(401, "INVALID_CREDENTIALS");
  await pool.query("DELETE FROM login_attempts WHERE identity_hash=$1", [
    digest(email.trim().toLowerCase()),
  ]);
  await pool.query(
    "INSERT INTO audit_logs VALUES($1,$2,'session.created',NULL,now())",
    [randomUUID(), rows[0].id],
  );
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions VALUES ($1,$2,now()+interval '12 hours')",
    [digest(token), rows[0].id],
  );
  return token;
}
