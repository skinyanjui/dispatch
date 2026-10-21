import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { POST } from "../../src/app/api/[...path]/route";
import {
  inviteStaff,
  listStaffInvites,
  removeOrganizationAdmin,
  revokeStaffInvite,
} from "../../src/lib/staff";
import { acceptInvite, inspectInvite } from "../../src/lib/onboarding";
import { organization } from "../../src/lib/account";
import { detail } from "../../src/lib/loads";
import { decrypt } from "../../src/lib/secrets";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
let t: Awaited<ReturnType<typeof tenant>>;
let owner: string;
before(async () => {
  t = await tenant("Staff");
  owner = t.dispatcher;
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, owner],
  );
});
after(() => pool.end());

const secret = () => randomBytes(32).toString("hex");
const invite = (over: Record<string, unknown> = {}) => ({
  key: randomUUID(),
  token: secret(),
  name: "New Dispatcher",
  email: `staff-${randomUUID().slice(0, 8)}@relay.test`,
  role: "dispatcher",
  carrier_ids: [t.carrier],
  ...over,
});
const asUser = (id: string) => ({ id, email: id + "@relay.test" });

test("owners and admins invite dispatchers; only owners invite admins; managers cannot invite", async () => {
  const admin = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Org Admin')",
    [admin, admin + "@relay.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [t.organization, admin],
  );
  await assert.rejects(inviteStaff(t.manager, t.organization, invite()), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    inviteStaff(t.foreignManager, t.organization, invite()),
    {
      code: "NOT_FOUND",
    },
  );
  await inviteStaff(admin, t.organization, invite());
  await assert.rejects(
    inviteStaff(admin, t.organization, invite({ role: "admin" })),
    {
      code: "OWNER_REQUIRED",
    },
  );
  await inviteStaff(
    owner,
    t.organization,
    invite({ role: "admin", carrier_ids: [] }),
  );
  await assert.rejects(
    inviteStaff(owner, t.organization, invite({ carrier_ids: [] })),
    { name: "ZodError" },
  );
  // Carriers must belong to the inviting organization.
  const other = await tenant("OtherOrg");
  await assert.rejects(
    inviteStaff(
      owner,
      t.organization,
      invite({ carrier_ids: [other.carrier] }),
    ),
    { code: "CARRIER_NOT_IN_ORGANIZATION" },
  );
  await assert.rejects(
    inviteStaff(other.dispatcher, t.organization, invite()),
    { code: "NOT_FOUND" },
  );
});

test("invitation is emailed through the outbox, replaces earlier links, and is idempotent", async () => {
  const input = invite();
  const first = await inviteStaff(
    owner,
    t.organization,
    input,
    "https://relay.example",
  );
  assert.deepEqual(
    await inviteStaff(owner, t.organization, input, "https://relay.example"),
    first,
  );
  await assert.rejects(
    inviteStaff(owner, t.organization, { ...input, name: "Changed" }),
    {
      code: "IDEMPOTENCY_CONFLICT",
    },
  );
  const queued = await pool.query(
    "SELECT body_ciphertext FROM notifications WHERE recipient_email=$1 AND kind='invitation'",
    [input.email],
  );
  assert.equal(queued.rowCount, 1);
  assert.match(
    decrypt(queued.rows[0].body_ciphertext),
    new RegExp(`https://relay.example/join#${input.token}`),
  );
  assert.ok(!queued.rows[0].body_ciphertext.includes(input.token));
  const again = invite({ email: input.email });
  await inviteStaff(owner, t.organization, again);
  await assert.rejects(inspectInvite({ token: input.token }), {
    code: "INVITE_UNAVAILABLE",
  });
  const pending = await listStaffInvites(owner, t.organization);
  assert.equal(
    pending.invites.filter((i: { email: string }) => i.email === input.email)
      .length,
    1,
  );
  await assert.rejects(listStaffInvites(t.manager, t.organization), {
    code: "NOT_FOUND",
  });
});

test("a new dispatcher joins, sees only the chosen carrier, and the link is single use", async () => {
  const input = invite({ carrier_ids: [t.carrier] });
  await inviteStaff(owner, t.organization, input);
  const view = await inspectInvite({ token: input.token });
  assert.equal(view.role, "dispatcher");
  assert.equal(view.account_exists, false);
  await assert.rejects(
    acceptInvite({ token: input.token, name: "New Dispatcher", phone: "" }),
    { code: "PASSWORD_REQUIRED" },
  );
  const accepted = await acceptInvite({
    token: input.token,
    name: "Pat Dispatcher",
    password: "fictional-staff-password",
    phone: "312-555-0100",
  });
  assert.equal(accepted.role, "dispatcher");
  assert.equal(accepted.sessionToken.length, 64);
  const user = (
    await pool.query(
      "SELECT id,phone,email_verified_at FROM users WHERE email=$1",
      [input.email],
    )
  ).rows[0];
  assert.equal(user.phone, "312-555-0100");
  assert.ok(user.email_verified_at);
  const roles = await pool.query(
    "SELECT carrier_id,role FROM memberships WHERE user_id=$1",
    [user.id],
  );
  assert.deepEqual(roles.rows, [{ carrier_id: t.carrier, role: "dispatcher" }]);
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const foreign = await bookedLoad(t.dispatcher, t.foreign);
  assert.ok(await detail(user.id, load.id));
  await assert.rejects(detail(user.id, foreign.id), { code: "NOT_FOUND" });
  // A dispatcher is not an administrator.
  await assert.rejects(organization(user.id, t.organization), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    acceptInvite({
      token: input.token,
      name: "x",
      password: "fictional-staff-password",
      phone: "",
    }),
    { code: "INVITE_UNAVAILABLE" },
  );
});

test("an administrator joins with organization access; existing accounts must sign in and cannot be downgraded", async () => {
  const input = invite({ role: "admin", carrier_ids: [] });
  await inviteStaff(owner, t.organization, input);
  const accepted = await acceptInvite({
    token: input.token,
    name: "Alex Admin",
    password: "fictional-admin-password",
    phone: "",
  });
  assert.equal(accepted.role, "admin");
  const adminId = (
    await pool.query("SELECT id FROM users WHERE email=$1", [input.email])
  ).rows[0].id;
  assert.equal((await organization(adminId, t.organization)).role, "admin");
  // Existing account: signing in as the invited address is required.
  const existing = invite({
    email: t.driverUser + "@relay.test",
    carrier_ids: [t.carrier],
  });
  await inviteStaff(owner, t.organization, existing);
  await assert.rejects(
    acceptInvite({ token: existing.token, name: "Driver", phone: "" }),
    { code: "INVITE_SIGN_IN_REQUIRED" },
  );
  await assert.rejects(
    acceptInvite(
      { token: existing.token, name: "Driver", phone: "" },
      asUser(t.manager),
    ),
    { code: "INVITE_SIGN_IN_REQUIRED" },
  );
  // The driver already holds a driver role on that carrier: refuse to mix.
  await assert.rejects(
    acceptInvite(
      { token: existing.token, name: "Driver", phone: "" },
      asUser(t.driverUser),
    ),
    { code: "MEMBERSHIP_CONFLICT" },
  );
  assert.equal(
    (
      await pool.query(
        "SELECT role FROM memberships WHERE user_id=$1 AND carrier_id=$2",
        [t.driverUser, t.carrier],
      )
    ).rows[0].role,
    "driver",
  );
});

test("revoking and expiry make links unusable; admin removal is owner-only", async () => {
  const a = invite();
  const sent = await inviteStaff(owner, t.organization, a);
  await revokeStaffInvite(owner, t.organization, sent.id);
  await assert.rejects(inspectInvite({ token: a.token }), {
    code: "INVITE_UNAVAILABLE",
  });
  await assert.rejects(revokeStaffInvite(owner, t.organization, sent.id), {
    code: "NOT_FOUND",
  });
  const b = invite();
  const expiring = await inviteStaff(owner, t.organization, b);
  await pool.query(
    "UPDATE staff_invites SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [expiring.id],
  );
  await assert.rejects(
    acceptInvite({
      token: b.token,
      name: "x",
      password: "fictional-staff-password",
      phone: "",
    }),
    { code: "INVITE_UNAVAILABLE" },
  );
  // Admin removal.
  const admin = randomUUID();
  const peer = randomUUID();
  for (const id of [admin, peer])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'x','Admin')",
      [id, id + "@relay.test"],
    );
  for (const id of [admin, peer])
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",
      [t.organization, id],
    );
  const reason = { reason: "Left the company" };
  await assert.rejects(
    removeOrganizationAdmin(admin, t.organization, {
      user_id: peer,
      ...reason,
    }),
    {
      code: "OWNER_REQUIRED",
    },
  );
  await assert.rejects(
    removeOrganizationAdmin(owner, t.organization, {
      user_id: owner,
      ...reason,
    }),
    {
      code: "CANNOT_REMOVE_SELF",
    },
  );
  await removeOrganizationAdmin(owner, t.organization, {
    user_id: peer,
    ...reason,
  });
  await assert.rejects(organization(peer, t.organization), {
    code: "NOT_FOUND",
  });
  const events = await pool.query(
    "SELECT type FROM organization_events WHERE organization_id=$1 ORDER BY created_at",
    [t.organization],
  );
  assert.ok(events.rows.some((e) => e.type === "organization_admin.removed"));
  assert.ok(events.rows.some((e) => e.type === "staff_invitation.revoked"));
});

test("HTTP: invitations require an organization session and an origin", async () => {
  const token = await sessionFor(t.manager);
  const denied = await POST(
    request(`organizations/${t.organization}/invites`, {
      token,
      json: invite(),
    }),
  );
  assert.equal(denied.status, 404);
  const ownerToken = await sessionFor(owner);
  const input = invite();
  const created = await POST(
    request(`organizations/${t.organization}/invites`, {
      token: ownerToken,
      json: input,
    }),
  );
  assert.equal(created.status, 201);
  const forged = await POST(
    request(`organizations/${t.organization}/invites`, {
      token: ownerToken,
      json: invite(),
      headers: { origin: "https://untrusted.example" },
    }),
  );
  assert.equal(forged.status, 403);
  const accepted = await POST(
    request("onboarding/invitations/accept", {
      json: {
        token: input.token,
        name: "HTTP Dispatcher",
        password: "fictional-http-password",
      },
    }),
  );
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get("set-cookie") || "", /relay_session=/);
});
