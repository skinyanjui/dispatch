import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import { digest, hashNewPassword, login } from "../../src/lib/auth";
import { completePasswordReset } from "../../src/lib/account";
import {
  approveAccessRequest,
  declineAccessRequest,
  listAccessRequests,
  requestFromProvider,
  submitAccessRequest,
} from "../../src/lib/access-requests";
import { legalVersion } from "../../src/lib/legal";
import { request } from "./fixtures";

after(() => pool.end());

const unique = () => "req-" + randomUUID().slice(0, 8);
const body = (over: Record<string, unknown> = {}) => ({
  name: "Riley Owner",
  email: `${unique()}@company.test`,
  company: "Fictional Dispatch Co " + unique(),
  terms_accepted: true,
  terms_version: legalVersion,
  ...over,
});
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    if ((e as Error).name === "ZodError") return 400;
    return (e as { status?: number }).status ?? 500;
  }
};
const rowFor = async (email: string) =>
  (await pool.query("SELECT * FROM access_requests WHERE email=$1", [email]))
    .rows;

test("a request stores the details and the accepted version, and creates nothing else", async () => {
  const data = body({ phone: "(555) 010-0100", note: "Two trucks" });
  assert.deepEqual(await submitAccessRequest(data), { ok: true });
  const [row] = await rowFor(data.email as string);
  assert.equal(row.status, "pending");
  assert.equal(row.source, "form");
  assert.equal(row.terms_version, legalVersion);
  assert.ok(row.terms_accepted_at);
  assert.equal(row.email_verified, false);
  // No account, organization or session exists because of a request.
  assert.equal(
    (await pool.query("SELECT 1 FROM users WHERE email=$1", [data.email]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM organizations WHERE name=$1", [
        data.company,
      ])
    ).rowCount,
    0,
  );
  const mail = await pool.query(
    "SELECT 1 FROM notifications WHERE recipient_email=$1",
    [data.email],
  );
  assert.equal(mail.rowCount, 0);
});

test("input is validated: terms, version, email, lengths and unknown fields", async () => {
  for (const bad of [
    { terms_accepted: false },
    { terms_accepted: undefined },
    { email: "not-an-email" },
    { name: "  " },
    { company: "" },
    { note: "x".repeat(501) },
    { phone: "1".repeat(41) },
    { extra: "field" },
  ])
    assert.equal(
      await status(submitAccessRequest(body(bad))),
      400,
      JSON.stringify(bad),
    );
  // Text the person did not see is not accepted.
  assert.equal(
    await status(submitAccessRequest(body({ terms_version: "1999-01-01.1" }))),
    409,
  );
});

test("the answer never reveals whether an address has an account or a request", async () => {
  const fresh = body();
  const a = await submitAccessRequest(fresh);
  // The same pending address again, and an address that already has an account.
  const b = await submitAccessRequest({ ...fresh });
  const existing = `${unique()}@company.test`;
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Existing')",
    [randomUUID(), existing],
  );
  const c = await submitAccessRequest(body({ email: existing }));
  assert.deepEqual([a, b, c], [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal((await rowFor(fresh.email as string)).length, 1);
  assert.equal((await rowFor(existing)).length, 0);
});

test("a filled honeypot stores nothing, and repeats are rate limited", async () => {
  const bot = body({ website: "http://spam.example" });
  assert.deepEqual(await submitAccessRequest(bot), { ok: true });
  assert.equal((await rowFor(bot.email as string)).length, 0);
  const repeated = body();
  for (let i = 0; i < 3; i++) await submitAccessRequest(repeated);
  assert.equal(await status(submitAccessRequest(repeated)), 429);
});

test("HTTP: public, same-origin and JSON only", async () => {
  const data = body();
  const ok = await POST(request("access-requests", { json: data }));
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { ok: true });
  const cross = await POST(
    request("access-requests", {
      json: body(),
      headers: { Origin: "https://untrusted.example" },
    }),
  );
  assert.equal(cross.status, 403);
  const form = await POST(
    request("access-requests", {
      body: new URLSearchParams({ email: "a@b.test" }),
    }),
  );
  assert.equal(form.status, 415);
});

test("approval creates the organization and a private link; the owner sets a password and signs in", async () => {
  const data = body();
  await submitAccessRequest(data);
  const [row] = await rowFor(data.email as string);
  const pending = await listAccessRequests("pending");
  assert.ok(pending.some((r) => r.id === row.id));
  const result = await approveAccessRequest(row.id, "https://relay.example");
  assert.equal(result.created_user, true);
  assert.match(
    result.setup_link!,
    /^https:\/\/relay\.example\/reset-password#[a-f0-9]{64}$/,
  );
  // The new account is an owner of its own organization only.
  const member = await pool.query(
    "SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2",
    [result.organization_id, result.user_id],
  );
  assert.equal(member.rows[0].role, "owner");
  const org = await pool.query("SELECT name FROM organizations WHERE id=$1", [
    result.organization_id,
  ]);
  assert.equal(org.rows[0].name, data.company);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM memberships WHERE user_id=$1", [
        result.user_id,
      ])
    ).rowCount,
    0,
  );
  // Nobody can sign in until the link is used.
  await assert.rejects(login(data.email as string, "guess-guess-guess"), {
    code: "INVALID_CREDENTIALS",
  });
  const token = result.setup_link!.split("#")[1];
  const link = await pool.query(
    "SELECT expires_at-now() AS ttl FROM account_tokens WHERE token_hash=$1",
    [digest(token)],
  );
  assert.ok(link.rows[0].ttl.days >= 6);
  await completePasswordReset({ token, password: "a-long-chosen-password" });
  const signed = await login(data.email as string, "a-long-chosen-password");
  assert.ok("token" in signed);
  // The link was emailed to the address, so using it verified the address.
  const user = await pool.query(
    "SELECT email_verified_at FROM users WHERE id=$1",
    [result.user_id],
  );
  assert.ok(user.rows[0].email_verified_at);
  // The link works once.
  await assert.rejects(
    completePasswordReset({ token, password: "another-long-password" }),
    { code: "TOKEN_UNAVAILABLE" },
  );
  // The invitation is queued through the outbox, and the action is audited.
  const mail = await pool.query(
    "SELECT kind FROM notifications WHERE dedupe_key=$1",
    ["access-approved:" + row.id],
  );
  assert.equal(mail.rows[0].kind, "invitation");
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE resource_id=ANY($1) ORDER BY created_at",
    [[row.id, result.organization_id]],
  );
  assert.deepEqual(audit.rows.map((r) => r.action).sort(), [
    "access.approved",
    "organization.created",
  ]);
  // Approving again returns the same organization and no new link.
  const again = await approveAccessRequest(row.id);
  assert.deepEqual(
    [again.organization_id, again.setup_link, again.repeated],
    [result.organization_id, null, true],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM organizations WHERE name=$1",
        [data.company],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(declineAccessRequest(row.id), {
    code: "ALREADY_APPROVED",
  });
});

test("an existing account keeps its password and becomes the owner", async () => {
  const email = `${unique()}@company.test`;
  const id = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,'Existing Person')",
    [id, email, await hashNewPassword("existing-password-123")],
  );
  // A person with an account cannot file a request, but a provider-created
  // request can predate the account.
  await pool.query(
    "INSERT INTO access_requests(id,email,name,company,source,email_verified) VALUES($1,$2,'Existing Person','Existing Co','google',true)",
    [randomUUID(), email],
  );
  const [row] = await rowFor(email);
  const result = await approveAccessRequest(row.id);
  assert.deepEqual(
    [result.created_user, result.setup_link, result.user_id],
    [false, null, id],
  );
  assert.ok("token" in (await login(email, "existing-password-123")));
});

test("declining records a reason, creates nothing and blocks approval", async () => {
  const data = body();
  await submitAccessRequest(data);
  const [row] = await rowFor(data.email as string);
  await declineAccessRequest(row.id, "Not a dispatch company");
  const after = (await rowFor(data.email as string))[0];
  assert.deepEqual(
    [after.status, after.decision_note],
    ["declined", "Not a dispatch company"],
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM organizations WHERE name=$1", [
        data.company,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(approveAccessRequest(row.id), {
    code: "ALREADY_DECLINED",
  });
  // After a decision the person may ask again.
  await submitAccessRequest(body({ email: data.email }));
  assert.equal(
    (await rowFor(data.email as string)).filter((r) => r.status === "pending")
      .length,
    1,
  );
  assert.equal(await status(approveAccessRequest(randomUUID())), 404);
  assert.equal(await status(approveAccessRequest("not-a-uuid")), 400);
});

test("a provider sign-in without an account becomes a verified request, once", async () => {
  const email = `${unique()}@company.test`;
  await requestFromProvider("google", { email, name: "Pat Lee" });
  await requestFromProvider("google", { email, name: "Pat Lee" });
  const rows = await rowFor(email);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].source, rows[0].email_verified, rows[0].status],
    ["google", true, "pending"],
  );
  assert.equal(rows[0].terms_accepted_at, null);
  const approved = await approveAccessRequest(rows[0].id);
  const user = await pool.query(
    "SELECT email_verified_at FROM users WHERE id=$1",
    [approved.user_id],
  );
  assert.ok(
    user.rows[0].email_verified_at,
    "a provider-verified address is verified",
  );
  // An existing account never gets a request.
  await requestFromProvider("apple", { email, name: "Pat Lee" });
  assert.equal((await rowFor(email)).length, 1);
});
