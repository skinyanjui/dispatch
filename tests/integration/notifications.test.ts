import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  deliverDue,
  maxAttempts,
  notificationLog,
  PermanentDeliveryError,
  retryNotification,
  savePreference,
  scheduleReminders,
  setTransport,
  type Email,
} from "../../src/lib/notifications";
import { decrypt, encrypt } from "../../src/lib/secrets";
import { inviteDriver } from "../../src/lib/onboarding";
import { mutate } from "../../src/lib/loads";
import { openException } from "../../src/lib/exceptions";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
let t: Awaited<ReturnType<typeof tenant>>;
const outbox: Email[] = [];
let failNext: Error | null = null;
before(async () => {
  t = await tenant("Notify");
  // Isolate from rows other test files may have queued.
  await pool.query(
    "UPDATE notifications SET status='suppressed',body_ciphertext=NULL WHERE status='pending'",
  );
});
beforeEach(() => {
  outbox.length = 0;
  failNext = null;
  setTransport({
    name: "test",
    async send(email) {
      if (failNext) throw failNext;
      outbox.push(email);
      return "provider-" + email.id;
    },
  });
});
after(async () => {
  setTransport(null);
  await pool.end();
});
const token = () => randomBytes(32).toString("hex");
// Other test files run concurrently and may queue messages too, so assertions
// look only at this tenant's recipients and rows.
const mine = (to: string) => outbox.filter((e) => e.to === to);
const statusOf = async (where: string, params: unknown[]) =>
  (
    await pool.query(`SELECT status FROM notifications WHERE ${where}`, params)
  ).rows.map((r) => r.status);

test("sealed bodies round-trip and do not contain the plaintext", () => {
  const sealed = encrypt("secret link https://relay.test/join#abc")!;
  assert.ok(!sealed.includes("join#abc"));
  assert.equal(decrypt(sealed), "secret link https://relay.test/join#abc");
  // Tampering must be detected. Flip a real bit (the last base64 character can
  // carry unused bits, so editing it is sometimes a no-op) in the ciphertext
  // and, separately, in the authentication tag.
  const [version, iv, tag, body] = sealed.split(".");
  const flip = (b64: string) => {
    const bytes = Buffer.from(b64, "base64");
    bytes[0] ^= 1;
    return bytes.toString("base64");
  };
  assert.throws(() => decrypt([version, iv, tag, flip(body)].join(".")));
  assert.throws(() => decrypt([version, iv, flip(tag), body].join(".")));
});

test("invitations queue an encrypted email in the same transaction and deliver once", async () => {
  const secret = token();
  const email = "invitee-" + randomUUID().slice(0, 6) + "@relay.test";
  const key = randomUUID();
  const invite = {
    key,
    token: secret,
    name: "Invited Driver",
    email,
  };
  await inviteDriver(
    t.manager,
    t.carrier,
    invite,
    undefined,
    "https://relay.example",
  );
  await inviteDriver(
    t.manager,
    t.carrier,
    invite,
    undefined,
    "https://relay.example",
  );
  const queued = await pool.query(
    "SELECT * FROM notifications WHERE recipient_email=$1",
    [email],
  );
  assert.equal(queued.rowCount, 1);
  assert.equal(queued.rows[0].kind, "invitation");
  assert.ok(!queued.rows[0].body_ciphertext.includes(secret));
  await deliverDue(1000);
  assert.equal(mine(email).length, 1);
  assert.match(
    mine(email)[0].text,
    new RegExp(`https://relay.example/join#${secret}`),
  );
  const sent = await pool.query("SELECT * FROM notifications WHERE id=$1", [
    queued.rows[0].id,
  ]);
  assert.equal(sent.rows[0].status, "sent");
  assert.equal(sent.rows[0].body_ciphertext, null);
  assert.equal(
    sent.rows[0].provider_message_id,
    "provider-" + queued.rows[0].id,
  );
  await deliverDue(1000);
  assert.equal(mine(email).length, 1);
});

test("failures back off, become terminal, and can be retried by a dispatcher", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: 1,
    driverId: t.driver,
  });
  const row = async () =>
    (
      await pool.query(
        "SELECT * FROM notifications WHERE kind='assignment' AND recipient_user_id=$1 AND dedupe_key LIKE $2",
        [t.driverUser, `assignment:${load.id}:%`],
      )
    ).rows[0];
  assert.match((await row()).subject, new RegExp(load.reference));
  failNext = new Error("Provider responded 503");
  await deliverDue(1000);
  let n = await row();
  assert.equal(n.status, "pending");
  assert.equal(n.attempts, 1);
  assert.ok(Date.parse(n.next_attempt_at) > Date.now() + 30000);
  await deliverDue(1000);
  assert.equal((await row()).attempts, 1, "not due yet");
  await pool.query(
    "UPDATE notifications SET next_attempt_at=now(),attempts=$2 WHERE id=$1",
    [n.id, maxAttempts - 1],
  );
  await deliverDue(1000);
  n = await row();
  assert.equal(n.status, "failed");
  assert.equal(n.last_error, "Provider responded 503");
  await assert.rejects(retryNotification(t.manager, n.id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(retryNotification(t.foreignManager, n.id), {
    code: "NOT_FOUND",
  });
  await retryNotification(t.dispatcher, n.id);
  failNext = null;
  await deliverDue(1000);
  assert.equal((await row()).status, "sent");
  assert.equal(mine(t.driverUser + "@relay.test").length, 1);
  // A permanent rejection is not retried.
  const second = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, second.id, "assign", {
    version: 1,
    driverId: t.driver,
  });
  failNext = new PermanentDeliveryError("Provider responded 422");
  await deliverDue(1000);
  assert.deepEqual(
    await statusOf("kind='assignment' AND dedupe_key LIKE $1", [
      `assignment:${second.id}:%`,
    ]),
    ["failed"],
  );
});

test("preferences mute optional kinds but never security or invitation mail", async () => {
  await savePreference(t.dispatcher, {
    kind: "exception_assigned",
    email: false,
  });
  await assert.rejects(
    savePreference(t.dispatcher, { kind: "password_reset", email: false }),
    { name: "ZodError" },
  );
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await openException(t.manager, load.id, {
    type: "delay",
    severity: "low",
    summary: "Muted owner",
    owner_id: t.dispatcher,
    idempotency_key: randomUUID(),
  });
  await openException(t.dispatcher, load.id, {
    type: "delay",
    severity: "low",
    summary: "Notify manager",
    owner_id: t.manager,
    idempotency_key: randomUUID(),
  });
  await deliverDue(1000);
  assert.deepEqual(
    await statusOf("kind='exception_assigned' AND recipient_user_id=$1", [
      t.dispatcher,
    ]),
    ["suppressed"],
  );
  assert.equal(mine(t.manager + "@relay.test").length, 1);
  assert.equal(mine(t.dispatcher + "@relay.test").length, 0);
  // Self-assignment does not notify.
  await openException(t.manager, load.id, {
    type: "delay",
    severity: "low",
    summary: "Self",
    owner_id: t.manager,
    idempotency_key: randomUUID(),
  });
  await deliverDue(1000);
  assert.equal(mine(t.manager + "@relay.test").length, 1);
});

test("reminders are idempotent per period and scoped to carrier members", async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  await mutate(t.dispatcher, load.id, "assign", {
    version: 1,
    driverId: t.driver,
  });
  let v = 2;
  for (const stage of ["dispatched", "picked-up", "delivered"])
    v = (
      await mutate(t.dispatcher, load.id, "milestones", { version: v, stage })
    ).version;
  await pool.query(
    "ALTER TABLE load_events DISABLE TRIGGER immutable_load_events",
  );
  await pool.query(
    "UPDATE load_events SET created_at=now()-interval '2 days' WHERE load_id=$1",
    [load.id],
  );
  await pool.query(
    "ALTER TABLE load_events ENABLE TRIGGER immutable_load_events",
  );
  await pool.query(
    "UPDATE load_exceptions SET due_at=now()-interval '1 hour' WHERE carrier_id=$1 AND owner_id IS NOT NULL",
    [t.carrier],
  );
  await scheduleReminders();
  await scheduleReminders();
  const pods = await pool.query(
    "SELECT recipient_user_id FROM notifications WHERE kind='document_reminder' AND dedupe_key LIKE $1",
    [`document_reminder:${load.id}:%`],
  );
  assert.deepEqual(
    pods.rows.map((r) => r.recipient_user_id).sort(),
    [t.dispatcher, t.manager].sort(),
  );
  const overdue = await pool.query(
    "SELECT count(*)::int n FROM notifications WHERE kind='exception_overdue' AND recipient_user_id=$1",
    [t.manager],
  );
  assert.ok(overdue.rows[0].n >= 1);
  const log = await notificationLog(t.dispatcher);
  assert.ok(log.notifications.every((n) => !("body_ciphertext" in n)));
  const foreignLog = await notificationLog(t.foreignManager);
  assert.equal(foreignLog.notifications.length, 0);
});

test("job endpoint requires the cron secret; log and retry need a session", async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await GET(request("jobs/notifications"))).status, 503);
  process.env.CRON_SECRET = "fictional-cron-secret-for-tests";
  assert.equal(
    (
      await GET(
        request("jobs/notifications", {
          headers: { authorization: "Bearer wrong-secret-of-same-size!!" },
        }),
      )
    ).status,
    401,
  );
  const ok = await GET(
    request("jobs/notifications", {
      headers: { authorization: "Bearer fictional-cron-secret-for-tests" },
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal((await GET(request("notifications"))).status, 401);
  const session = await sessionFor(t.manager);
  const prefs = await POST(
    request("notifications/preferences", {
      token: session,
      json: { kind: "document_reminder", email: false },
    }),
  );
  assert.equal(prefs.status, 200);
  assert.equal((await prefs.json()).document_reminder, false);
});
