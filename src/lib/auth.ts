import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { pool } from "./db";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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
  const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [
    email.toLowerCase(),
  ]);
  const fallback = "00000000000000000000000000000000:" + "00".repeat(64);
  const valid = verifyPassword(password, rows[0]?.password_hash ?? fallback);
  if (!rows[0] || !valid) throw new HttpError(401, "INVALID_CREDENTIALS");
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions VALUES ($1,$2,now()+interval '12 hours')",
    [digest(token), rows[0].id],
  );
  return token;
}
