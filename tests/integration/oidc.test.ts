import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { NextRequest } from "next/server";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { digest } from "../../src/lib/auth";
import { mfaEnable, mfaSetup } from "../../src/lib/account";
import { codeAt, stepAt } from "../../src/lib/totp";
import { appleClientSecret } from "../../src/lib/oidc";
import { origin, request, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");

// A stand-in for Google and Apple: our own RSA keys, JWKS and token endpoint.
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const kid = "test-key";
const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");
function idToken(claims: object, key = rsa.privateKey) {
  const head = b64(JSON.stringify({ alg: "RS256", kid }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${b64(sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key))}`;
}

const realFetch = globalThis.fetch;
let claimsFor: (nonce: string) => object = () => ({});
let tokenRequests: URLSearchParams[] = [];
let outage = false;
let lastNonce = "";
before(() => {
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.APPLE_CLIENT_ID = "com.example.relay";
  process.env.APPLE_TEAM_ID = "TEAM123456";
  process.env.APPLE_KEY_ID = "KEY1234567";
  process.env.APPLE_PRIVATE_KEY = ec.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      /googleapis\.com\/oauth2\/v3\/certs|appleid\.apple\.com\/auth\/keys/.test(
        url,
      )
    )
      return Response.json({
        keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid }],
      });
    if (
      /oauth2\.googleapis\.com\/token|appleid\.apple\.com\/auth\/token/.test(
        url,
      )
    ) {
      if (outage) return new Response("down", { status: 503 });
      const form = new URLSearchParams(String(init?.body));
      tokenRequests.push(form);
      return Response.json({
        id_token: idToken(claimsFor(lastNonce), signingKey),
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
let signingKey = rsa.privateKey;
after(async () => {
  globalThis.fetch = realFetch;
  await pool.end();
});

const now = () => Math.floor(Date.now() / 1000);
const good = (
  provider: "google" | "apple",
  over: Record<string, unknown> = {},
) => ({
  iss:
    provider === "google"
      ? "https://accounts.google.com"
      : "https://appleid.apple.com",
  aud: provider === "google" ? "google-client" : "com.example.relay",
  exp: now() + 300,
  sub: "sub-" + randomUUID(),
  email_verified: true,
  ...over,
});

/** Runs start then callback as a browser would; returns the callback response. */
async function signIn(
  provider: "google" | "apple",
  claims: (nonce: string) => object,
  opts: { remember?: boolean; mutateState?: (s: string) => string } = {},
) {
  const start = await GET(
    request(`auth/oidc/${provider}/start${opts.remember ? "?remember=1" : ""}`),
  );
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  lastNonce = authorize.searchParams.get("nonce")!;
  claimsFor = (nonce) => ({ nonce, ...claims(nonce) });
  const cookie = /relay_oidc=([^;]+)/.exec(
    start.headers.get("set-cookie")!,
  )![1];
  assert.equal(cookie, state);
  const sent = opts.mutateState ? opts.mutateState(state) : state;
  const headers = { cookie: "relay_oidc=" + cookie };
  const response =
    provider === "apple"
      ? await POST(
          new NextRequest(`${origin}/api/auth/oidc/apple/callback`, {
            method: "POST",
            // A cross-site form post: the browser sends the provider's origin.
            headers: { ...headers, origin: "https://appleid.apple.com" },
            body: new URLSearchParams({ code: "code-1", state: sent }),
          }),
        )
      : await GET(
          request(`auth/oidc/google/callback?code=code-1&state=${sent}`, {
            headers,
          }),
        );
  return { response, state, authorize };
}
const emailOf = async (id: string) =>
  (await pool.query("SELECT email FROM users WHERE id=$1", [id])).rows[0].email;
const where = (r: Response) => r.headers.get("location") ?? "";
const signedIn = (r: Response) =>
  /relay_session=/.test(r.headers.get("set-cookie") ?? "");

test("providers are listed without secrets, and an unconfigured one refuses", async () => {
  const body = await (await GET(request("auth/providers"))).json();
  assert.deepEqual(body, { google: true, apple: true });
  assert.ok(!JSON.stringify(body).includes("secret"));
  const saved = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    assert.deepEqual(await (await GET(request("auth/providers"))).json(), {
      google: false,
      apple: true,
    });
    const start = await GET(request("auth/oidc/google/start"));
    assert.match(where(start), /social_error=PROVIDER_NOT_CONFIGURED/);
    assert.equal(start.headers.get("set-cookie"), null);
  } finally {
    process.env.GOOGLE_CLIENT_SECRET = saved;
  }
  assert.equal((await GET(request("auth/oidc/github/start"))).status, 404);
});

test("start sends state, nonce and a PKCE challenge, and the token request proves the verifier", async () => {
  tokenRequests = [];
  const t = await tenant("oidc-pkce");
  const email = await emailOf(t.manager);
  const { response, authorize, state } = await signIn("google", () =>
    good("google", { email }),
  );
  assert.equal(
    authorize.origin + authorize.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("client_id"), "google-client");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    `${origin}/api/auth/oidc/google/callback`,
  );
  assert.ok(signedIn(response));
  const sent = tokenRequests.at(-1)!;
  assert.equal(
    createHash("sha256").update(sent.get("code_verifier")!).digest("base64url"),
    authorize.searchParams.get("code_challenge"),
  );
  assert.equal(sent.get("client_secret"), "google-secret");
  assert.equal(
    (
      await pool.query("SELECT 1 FROM oidc_states WHERE state_hash=$1", [
        digest(state),
      ])
    ).rowCount,
    0,
  );
});

test("a verified email matching an account links the identity and signs in", async () => {
  const t = await tenant("oidc-link");
  const email = (await emailOf(t.manager)).toUpperCase();
  const claims = good("google", { email });
  const first = await signIn("google", () => claims);
  assert.ok(signedIn(first.response));
  assert.equal(where(first.response), origin + "/");
  const linked = await pool.query(
    "SELECT user_id FROM external_identities WHERE provider='google' AND subject=$1",
    [claims.sub],
  );
  assert.equal(linked.rows[0].user_id, t.manager);
  const audit = await pool.query(
    "SELECT 1 FROM audit_logs WHERE actor_id=$1 AND action='auth.identity_linked'",
    [t.manager],
  );
  assert.equal(audit.rowCount, 1);
  // Next time the subject alone is enough, even if the email differs.
  const again = await signIn("google", () => ({
    ...claims,
    email: "other@x.test",
  }));
  assert.ok(signedIn(again.response));
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE actor_id=$1 AND action='auth.identity_linked'",
        [t.manager],
      )
    ).rowCount,
    1,
  );
});

test("an unverified provider email never links and never asks for access", async () => {
  const t = await tenant("oidc-unverified");
  const email = await emailOf(t.manager);
  const claims = good("google", { email, email_verified: false });
  const { response } = await signIn("google", () => claims);
  assert.match(where(response), /social_error=SOCIAL_EMAIL_UNVERIFIED/);
  assert.ok(!signedIn(response));
  assert.equal(
    (
      await pool.query("SELECT 1 FROM external_identities WHERE subject=$1", [
        claims.sub,
      ])
    ).rowCount,
    0,
  );
  const stranger = `nobody-${randomUUID().slice(0, 8)}@x.test`;
  const unknown = await signIn("google", () =>
    good("google", { email: stranger, email_verified: false }),
  );
  assert.match(where(unknown.response), /SOCIAL_EMAIL_UNVERIFIED/);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM access_requests WHERE email=$1", [
        stranger,
      ])
    ).rowCount,
    0,
  );
});

test("an unknown verified email becomes an access request, nothing else", async () => {
  const email = `new-${randomUUID().slice(0, 8)}@company.test`;
  const { response } = await signIn("apple", () =>
    good("apple", { email, email_verified: "true" }),
  );
  assert.equal(where(response), origin + "/?social=requested");
  assert.ok(!signedIn(response));
  const row = (
    await pool.query("SELECT * FROM access_requests WHERE email=$1", [email])
  ).rows[0];
  assert.equal(row.source, "apple");
  assert.equal(row.email_verified, true);
  assert.equal(row.status, "pending");
  assert.equal(
    (await pool.query("SELECT 1 FROM users WHERE email=$1", [email])).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE action='organization.created' AND resource_id=$1",
        [row.id],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM external_identities WHERE user_id IS NOT NULL AND email_at_link=$1",
        [email],
      )
    ).rowCount,
    0,
  );
});

test("state is bound to the browser and can be used once", async () => {
  const t = await tenant("oidc-state");
  const email = await emailOf(t.manager);
  const mismatch = await signIn("google", () => good("google", { email }), {
    mutateState: (s) => s.slice(0, -2) + "xx",
  });
  assert.match(where(mismatch.response), /SOCIAL_SIGNIN_FAILED/);
  assert.ok(!signedIn(mismatch.response));
  // No cookie at all (an attacker feeding a victim their own code).
  const start = await GET(request("auth/oidc/google/start"));
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const noCookie = await GET(
    request(`auth/oidc/google/callback?code=c&state=${state}`),
  );
  assert.match(where(noCookie), /SOCIAL_SIGNIN_FAILED/);
  // A good run cannot be replayed.
  const ok = await signIn("google", () => good("google", { email }));
  assert.ok(signedIn(ok.response));
  const replay = await GET(
    request(`auth/oidc/google/callback?code=c&state=${ok.state}`, {
      headers: { cookie: "relay_oidc=" + ok.state },
    }),
  );
  assert.match(where(replay), /SOCIAL_SIGNIN_FAILED/);
  assert.ok(!signedIn(replay));
  // An expired state is refused.
  const late = await GET(request("auth/oidc/google/start"));
  const lateState = new URL(late.headers.get("location")!).searchParams.get(
    "state",
  )!;
  await pool.query(
    "UPDATE oidc_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
    [digest(lateState)],
  );
  const expired = await GET(
    request(`auth/oidc/google/callback?code=c&state=${lateState}`, {
      headers: { cookie: "relay_oidc=" + lateState },
    }),
  );
  assert.match(where(expired), /SOCIAL_SIGNIN_FAILED/);
});

test("tokens with a wrong nonce, audience, issuer, expiry or signature are refused", async () => {
  const t = await tenant("oidc-token");
  const email = await emailOf(t.manager);
  const cases: [string, (n: string) => object, boolean?][] = [
    ["nonce", () => good("google", { email, nonce: "other" })],
    ["audience", () => good("google", { email, aud: "someone-else" })],
    ["issuer", () => good("google", { email, iss: "https://evil.example" })],
    ["expiry", () => good("google", { email, exp: now() - 3600 })],
    ["subject", () => good("google", { email, sub: "" })],
    ["signature", () => good("google", { email }), true],
  ];
  for (const [name, claims, forged] of cases) {
    signingKey = forged ? stranger.privateKey : rsa.privateKey;
    const result = await signIn("google", claims);
    signingKey = rsa.privateKey;
    assert.match(where(result.response), /SOCIAL_SIGNIN_FAILED/, name);
    assert.ok(!signedIn(result.response), name);
  }
  assert.equal(
    (
      await pool.query("SELECT 1 FROM external_identities WHERE user_id=$1", [
        t.manager,
      ])
    ).rowCount,
    0,
  );
});

test("accounts with two-step verification still need the second step", async () => {
  const t = await tenant("oidc-mfa");
  const email = await emailOf(t.dispatcher);
  const { secret } = await mfaSetup(t.dispatcher);
  await mfaEnable(t.dispatcher, { code: codeAt(secret, stepAt(Date.now())) });
  const { response } = await signIn("google", () => good("google", { email }), {
    remember: true,
  });
  assert.ok(!signedIn(response));
  const fragment = /#mfa=([0-9a-f]{64})$/.exec(where(response));
  assert.ok(fragment, where(response));
  const challenge = (
    await pool.query(
      "SELECT remember FROM mfa_challenges WHERE token_hash=$1",
      [digest(fragment![1])],
    )
  ).rows[0];
  assert.equal(challenge.remember, true);
});

test("remember carries through, and plain sign-in stays a browser-session cookie", async () => {
  const t = await tenant("oidc-remember");
  const email = await emailOf(t.manager);
  const remembered = await signIn("google", () => good("google", { email }), {
    remember: true,
  });
  assert.match(
    remembered.response.headers.get("set-cookie")!,
    /Max-Age=2592000/,
  );
  const plain = await signIn("google", () => good("google", { email }));
  const cookie = plain.response.headers
    .getSetCookie()
    .find((c) => c.startsWith("relay_session="))!;
  assert.doesNotMatch(cookie, /Max-Age|Expires/i);
});

test("Apple returns by cross-site form post, signed with an ES256 client secret", async () => {
  tokenRequests = [];
  const t = await tenant("oidc-apple");
  const email = await emailOf(t.manager);
  const { response } = await signIn("apple", () => good("apple", { email }));
  assert.ok(signedIn(response));
  const secret = tokenRequests.at(-1)!.get("client_secret")!;
  const [head, body, sig] = secret.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), {
    alg: "ES256",
    kid: "KEY1234567",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(claims.sub, "com.example.relay");
  assert.equal(claims.aud, "https://appleid.apple.com");
  assert.ok(claims.exp - claims.iat <= 900);
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${head}.${body}`),
      { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    ),
  );
  assert.equal(appleClientSecret(1000).split(".").length, 3);
  // Only this callback skips the same-origin check; other posts still need it.
  const other = await POST(
    new NextRequest(`${origin}/api/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ email: "a@b.test", password: "x" }),
    }),
  );
  assert.equal(other.status, 403);
});

test("a first Apple sign-in records the name Apple sends once", async () => {
  const email = `apple-${randomUUID().slice(0, 8)}@company.test`;
  const start = await GET(request("auth/oidc/apple/start"));
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  lastNonce = new URL(start.headers.get("location")!).searchParams.get(
    "nonce",
  )!;
  claimsFor = (nonce) => ({ ...good("apple", { email }), nonce });
  await POST(
    new NextRequest(`${origin}/api/auth/oidc/apple/callback`, {
      method: "POST",
      headers: { cookie: "relay_oidc=" + state },
      body: new URLSearchParams({
        code: "c",
        state,
        user: JSON.stringify({
          name: { firstName: "Ada", lastName: "Lovelace" },
        }),
      }),
    }),
  );
  const row = (
    await pool.query("SELECT name FROM access_requests WHERE email=$1", [email])
  ).rows[0];
  assert.equal(row.name.trim(), "Ada Lovelace");
});

test("a provider outage or a cancelled sign-in is explained and creates nothing", async () => {
  const t = await tenant("oidc-outage");
  const email = await emailOf(t.manager);
  outage = true;
  try {
    const { response } = await signIn("google", () =>
      good("google", { email }),
    );
    assert.match(where(response), /social_error=PROVIDER_UNAVAILABLE/);
    assert.ok(!signedIn(response));
  } finally {
    outage = false;
  }
  const cancelled = await GET(
    request("auth/oidc/google/callback?error=access_denied&state=x"),
  );
  assert.match(where(cancelled), /SOCIAL_SIGNIN_CANCELLED/);
});
