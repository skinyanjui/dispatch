import {
  createHash,
  createPublicKey,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type webcrypto,
} from "node:crypto";
import { pool } from "./db";
import { HttpError, consumeAttempt, digest, startSession } from "./auth";
import type { LoginResult } from "./auth";
import { requestFromProvider } from "./access-requests";
import { appOrigin } from "./notifications";

/**
 * Google and Apple sign-in over OpenID Connect (ADR 0034). Off until the
 * operator sets credentials. A person with no Relay account never gets one
 * here: their verified email becomes an access request for an operator.
 */
export type Provider = "google" | "apple";
export const providerNames: Provider[] = ["google", "apple"];
export const isProvider = (v: string): v is Provider =>
  (providerNames as string[]).includes(v);

const endpoints = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid email profile",
  },
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    jwks: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    scope: "name email",
  },
} as const;

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");
const env = (name: string) => process.env[name]?.trim() || "";

export function oidcConfigured(): Record<Provider, boolean> {
  return {
    google: !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET")),
    apple: !!(
      env("APPLE_CLIENT_ID") &&
      env("APPLE_TEAM_ID") &&
      env("APPLE_KEY_ID") &&
      env("APPLE_PRIVATE_KEY")
    ),
  };
}
const clientId = (p: Provider) =>
  env(p === "google" ? "GOOGLE_CLIENT_ID" : "APPLE_CLIENT_ID");

/** Apple's client secret is a short-lived ES256 JWT signed with our key. */
export function appleClientSecret(now = Math.floor(Date.now() / 1000)) {
  const header = b64(
    JSON.stringify({ alg: "ES256", kid: env("APPLE_KEY_ID"), typ: "JWT" }),
  );
  const payload = b64(
    JSON.stringify({
      iss: env("APPLE_TEAM_ID"),
      iat: now,
      exp: now + 600,
      aud: "https://appleid.apple.com",
      sub: clientId("apple"),
    }),
  );
  const key = createPrivateKey(env("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64(signature)}`;
}
const clientSecret = (p: Provider) =>
  p === "google" ? env("GOOGLE_CLIENT_SECRET") : appleClientSecret();

export const redirectUri = (p: Provider, origin?: string) =>
  `${appOrigin(origin)}/api/auth/oidc/${p}/callback`;

function configured(p: Provider) {
  if (!oidcConfigured()[p]) throw new HttpError(404, "PROVIDER_NOT_CONFIGURED");
}

/** Starts a sign-in: returns the provider URL and the state for the cookie. */
export async function beginOidc(
  provider: Provider,
  remember: boolean,
  origin?: string,
) {
  configured(provider);
  await consumeAttempt("oidc-start", 120);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  await pool.query("DELETE FROM oidc_states WHERE expires_at<now()");
  await pool.query(
    `INSERT INTO oidc_states(state_hash,provider,nonce,code_verifier,remember,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`,
    [digest(state), provider, nonce, verifier, remember],
  );
  const e = endpoints[provider];
  const url = new URL(e.authorize);
  url.search = new URLSearchParams({
    client_id: clientId(provider),
    redirect_uri: redirectUri(provider, origin),
    response_type: "code",
    scope: e.scope,
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(provider === "apple" ? { response_mode: "form_post" } : {}),
  }).toString();
  return { url: url.toString(), state };
}

type Claims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
};
const unavailable = () => new HttpError(503, "PROVIDER_UNAVAILABLE");
const invalid = () => new HttpError(400, "SOCIAL_SIGNIN_FAILED");

async function fetchJson(url: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  } catch {
    throw unavailable();
  }
  if (res.status >= 500) throw unavailable();
  if (!res.ok) throw invalid();
  return (await res.json()) as Record<string, unknown>;
}

/** Checks signature (RS256 against the provider's keys) and every claim. */
export async function verifyIdToken(
  provider: Provider,
  token: string,
  nonce: string,
  now = Date.now() / 1000,
): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid();
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    throw invalid();
  }
  if (header.alg !== "RS256") throw invalid();
  const keys = (await fetchJson(endpoints[provider].jwks)).keys;
  const jwk = Array.isArray(keys)
    ? (keys as (webcrypto.JsonWebKey & { kid?: string })[]).find(
        (k) => k.kid === header.kid,
      )
    : undefined;
  if (!jwk) throw invalid();
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2], "base64url"),
  );
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !ok ||
    !(endpoints[provider].issuers as readonly string[]).includes(
      claims.iss ?? "",
    ) ||
    !audience.includes(clientId(provider)) ||
    typeof claims.exp !== "number" ||
    claims.exp < now - 60 ||
    claims.nonce !== nonce ||
    !claims.sub
  )
    throw invalid();
  return claims;
}

export type OidcOutcome =
  | { kind: "session"; result: LoginResult }
  | { kind: "requested" };

/**
 * Finishes a sign-in. `cookieState` is the value the browser sent back; it
 * must equal the state in the URL or form, and the state is spent here so a
 * callback can never run twice.
 */
export async function finishOidc(
  provider: Provider,
  input: {
    code?: string;
    state?: string;
    cookieState?: string;
    user?: string;
  },
  origin?: string,
): Promise<OidcOutcome> {
  configured(provider);
  await consumeAttempt("oidc-callback", 120);
  const { state, cookieState, code } = input;
  if (!state || !cookieState || state !== cookieState || !code) throw invalid();
  const spent = await pool.query(
    `DELETE FROM oidc_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now()
    RETURNING nonce,code_verifier,remember`,
    [digest(state), provider],
  );
  if (!spent.rows[0]) throw invalid();
  const { nonce, code_verifier, remember } = spent.rows[0];
  const tokens = await fetchJson(endpoints[provider].token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(provider, origin),
      client_id: clientId(provider),
      client_secret: clientSecret(provider),
      code_verifier,
    }),
  });
  if (typeof tokens.id_token !== "string") throw invalid();
  const claims = await verifyIdToken(provider, tokens.id_token, nonce);
  const email = (claims.email ?? "").trim().toLowerCase();
  const verified =
    claims.email_verified === true || claims.email_verified === "true";
  const subject = claims.sub as string;

  const known = await pool.query(
    `SELECT u.id,u.mfa_enabled_at FROM external_identities i JOIN users u ON u.id=i.user_id
    WHERE i.provider=$1 AND i.subject=$2`,
    [provider, subject],
  );
  let user = known.rows[0] as { id: string; mfa_enabled_at: string | null };
  if (!user) {
    // An unverified provider email never links or requests anything.
    if (!email || !verified)
      throw new HttpError(400, "SOCIAL_EMAIL_UNVERIFIED");
    const match = await pool.query(
      "SELECT id,mfa_enabled_at FROM users WHERE email=$1",
      [email],
    );
    if (!match.rows[0]) {
      let name = claims.name ?? "";
      try {
        // Apple sends the name only on the first sign-in, in `user`.
        const given = JSON.parse(input.user ?? "{}").name ?? {};
        name = name || `${given.firstName ?? ""} ${given.lastName ?? ""}`;
      } catch {
        // A malformed name is not worth failing the request for.
      }
      await requestFromProvider(provider, { email, name });
      return { kind: "requested" };
    }
    user = match.rows[0];
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO external_identities(provider,subject,user_id,email_at_link)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [provider, subject, user.id, email],
      );
      await c.query(
        "INSERT INTO audit_logs VALUES($1,$2,'auth.identity_linked',$3,now())",
        [randomUUID(), user.id, provider],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  return {
    kind: "session",
    result: await startSession(user.id, !!user.mfa_enabled_at, remember),
  };
}
