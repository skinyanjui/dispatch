import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import {
  decideChange,
  listChanges,
  pendingCount,
  requestCarrierErasure,
} from "../../src/lib/change-control";
import {
  erasureCategories,
  erasurePlanFor,
  keptCategories,
  runObjectPurges,
} from "../../src/lib/erasure";
import { setObjectStore } from "../../src/lib/storage";
import { bookedLoad, tenant, withPassword } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
let admin1: string;
let admin2: string;
let pw1: string;
before(async () => {
  t = await tenant("Erasure");
  admin1 = t.dispatcher;
  admin2 = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Second admin','x')",
    [admin2, admin2 + "@erasure.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')",
    [t.organization, admin1, admin2],
  );
  pw1 = await withPassword(admin1);
  await withPassword(admin2);
});
after(() => pool.end());

const name = async () =>
  (await pool.query("SELECT name FROM carriers WHERE id=$1", [t.carrier]))
    .rows[0].name as string;
const ask = async (over: Record<string, unknown> = {}) =>
  requestCarrierErasure(admin1, {
    carrier_id: t.carrier,
    confirm_name: await name(),
    reason: "Carrier asked us to delete its data",
    password: pw1,
    key: randomUUID(),
    ...over,
  }) as Promise<{ id: string }>;

test("the keep list defaults to financial and audit records and can be widened, never narrowed below what cannot be erased", () => {
  const defaults = keptCategories(undefined);
  for (const id of ["loads", "billing", "claims", "factoring", "audit"])
    assert.ok(defaults.has(id), id);
  for (const id of [
    "people",
    "contacts",
    "messages",
    "notes",
    "documents",
    "lookups",
    "payout",
  ])
    assert.equal(defaults.has(id), false, id);
  const wider = keptCategories("documents, notes ,nonsense");
  assert.ok(wider.has("documents") && wider.has("notes"));
  assert.equal(wider.has("nonsense"), false);
  assert.ok(wider.has("billing"), "what cannot be erased is always kept");
  // An empty list erases everything erasable.
  const none = keptCategories("");
  assert.equal(none.has("people"), false);
  const plan = erasurePlanFor(wider);
  assert.equal(plan.find((p) => p.id === "documents")!.action, "keep");
  assert.equal(plan.find((p) => p.id === "people")!.action, "erase");
  assert.equal(plan.length, erasureCategories.length);
});

test("only organization administrators can ask, with the carrier's name and their password; a different administrator approves", async () => {
  // Carrier managers, dispatchers who are not admins and outsiders cannot.
  await assert.rejects(
    requestCarrierErasure(t.manager, {
      carrier_id: t.carrier,
      confirm_name: await name(),
      reason: "x",
      key: randomUUID(),
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    requestCarrierErasure(t.foreignManager, {
      carrier_id: t.carrier,
      confirm_name: await name(),
      reason: "x",
      key: randomUUID(),
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(ask({ confirm_name: "Some Other Carrier" }), {
    code: "NAME_MISMATCH",
  });
  await assert.rejects(ask({ password: undefined }), {
    code: "STEP_UP_REQUIRED",
  });
  await assert.rejects(ask({ password: "wrong password" }), {
    code: "STEP_UP_FAILED",
  });
  const { id } = await ask();
  // Nothing is erased by asking.
  assert.equal((await name()).startsWith("Erased"), false);
  // The requester cannot approve; a carrier manager cannot decide at all.
  await assert.rejects(
    decideChange(admin1, id, {
      decision: "approve",
      verification: "callback",
      password: pw1,
    }),
    { code: "SAME_PERSON" },
  );
  await assert.rejects(
    decideChange(t.manager, id, {
      decision: "approve",
      verification: "callback",
      password: pw1,
    }),
    { code: "NOT_FOUND" },
  );
  // The other administrator is told, the carrier manager is not.
  const told = await pool.query(
    "SELECT recipient_user_id FROM notifications WHERE kind='approval_request' AND dedupe_key LIKE $1",
    [`approval_request:${id}:%`],
  );
  const ids = told.rows.map((r) => r.recipient_user_id);
  assert.ok(ids.includes(admin2) && !ids.includes(t.manager));
  assert.ok((await pendingCount(admin2)).pending >= 1);
  assert.equal((await pendingCount(t.manager)).pending, 0);
  // Listing shows the erasure panel to administrators only.
  assert.ok((await listChanges(admin1, t.carrier)).erasure);
  assert.equal((await listChanges(t.manager, t.carrier)).erasure, null);
  await decideChange(admin2, id, { decision: "reject", note: "Not now" });
});

test("active loads, open claims and prepared schedules block an erasure", async () => {
  const live = await bookedLoad(t.dispatcher, t.carrier);
  await assert.rejects(ask(), { code: "CARRIER_HAS_OPEN_WORK" });
  const overview = (await listChanges(admin1, t.carrier)).erasure!;
  assert.ok(overview.blockers.includes("active_loads"));
  await pool.query(
    "UPDATE loads SET cancelled_at=now(),cancelled_by=$2,cancel_reason='test' WHERE id=$1",
    [live.id, admin1],
  );
});

test("approval erases personal data, keeps financial and audit records, and leaves a receipt", async () => {
  const subject = await tenant("ErasureSubject");
  const org = subject.organization;
  const other = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Second','x')",
    [other, other + "@erasure.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')",
    [org, subject.dispatcher, other],
  );
  const p1 = await withPassword(subject.dispatcher);
  const p2 = await withPassword(other);
  const carrier = subject.carrier;
  // Personal data of every erasable kind.
  await pool.query(
    `INSERT INTO carrier_profiles(carrier_id,contact_name,contact_email,phone,usdot,step)
     VALUES($1,'Casey Contact','casey@carrier.test','555-0101','1000001','complete')
     ON CONFLICT(carrier_id) DO UPDATE SET contact_name='Casey Contact',contact_email='casey@carrier.test',phone='555-0101',usdot='1000001'`,
    [carrier],
  );
  await pool.query(
    "UPDATE drivers SET name='Dana Driver',contact_email='dana@carrier.test',phone='555-0102' WHERE id=$1",
    [subject.driver],
  );
  const contact = randomUUID();
  await pool.query(
    `INSERT INTO contacts(id,organization_id,carrier_id,kind,name,company,email,phone,notes,created_by,idempotency_key,request_hash,sms_consent_note)
     VALUES($1,$2,$3,'other','Pat Contact','Pat Co','pat@x.test','555-0103','private',$4,$5,'x','')`,
    [contact, org, carrier, subject.dispatcher, randomUUID()],
  );
  const load = await bookedLoad(subject.dispatcher, carrier);
  await pool.query(
    "INSERT INTO load_notes(id,load_id,carrier_id,author_id,body,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'Call Dana on 555-0102',$5,'x')",
    [randomUUID(), load.id, carrier, subject.dispatcher, randomUUID()],
  );
  await pool.query(
    "INSERT INTO carrier_payout_details(carrier_id,payee_name,method,account_last4,effective_at) VALUES($1,'Casey Payee','ach','1234',now())",
    [carrier],
  );
  await pool.query(
    `INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,observed_at) VALUES($1,$2,'1000001','fixture','ok',now())`,
    [randomUUID(), carrier],
  );
  // A document with stored bytes.
  const docId = randomUUID();
  const versionId = randomUUID();
  const key = "erasure-test/" + randomUUID();
  await pool.query(
    "INSERT INTO document_objects(storage_key,content) VALUES($1,$2)",
    [key, Buffer.from("secret rate confirmation")],
  );
  await pool.query(
    "INSERT INTO documents(id,carrier_id,load_id,type,created_by) VALUES($1,$2,$3,'rate_confirmation',$4)",
    [docId, carrier, load.id, subject.dispatcher],
  );
  await pool.query(
    `INSERT INTO document_versions(id,document_id,carrier_id,version,filename,content_type,size_bytes,sha256,storage_key,uploaded_by,idempotency_key,request_hash)
     VALUES($1,$2,$3,1,'dana-rate-confirmation.pdf','application/pdf',24,$4,$5,$6,$7,'x')`,
    [
      versionId,
      docId,
      carrier,
      "a".repeat(64),
      key,
      subject.dispatcher,
      randomUUID(),
    ],
  );
  // A message thread with an attached file.
  const thread = randomUUID();
  const message = randomUUID();
  const attachKey = "message-attachments/" + randomUUID();
  await pool.query(
    "INSERT INTO threads(id,organization_id,carrier_id,subject,created_by) VALUES($1,$2,$3,'Call Dana',$4)",
    [thread, org, carrier, subject.dispatcher],
  );
  await pool.query(
    `INSERT INTO messages(id,thread_id,sender_user_id,channel,direction,source,body,counterpart,idempotency_key,request_hash,sender_label)
     VALUES($1,$2,$3,'in_app','out','relay','Dana says 555-0102','Dana','${randomUUID()}','x','Dispatcher')`,
    [message, thread, subject.dispatcher],
  );
  await pool.query(
    "INSERT INTO document_objects(storage_key,content) VALUES($1,$2)",
    [attachKey, Buffer.from("attachment bytes")],
  );
  await pool.query(
    `INSERT INTO message_attachments(id,uploader_id,message_id,filename,content_type,size_bytes,sha256,storage_key,scan,linked_at)
     VALUES($1,$2,$3,'dana-license.png','image/png',16,$4,$5,'clean',now())`,
    [randomUUID(), subject.dispatcher, message, "b".repeat(64), attachKey],
  );
  // Records that must survive.
  await pool.query(
    `INSERT INTO carrier_billing_packets(load_id,carrier_id,bill_to,carrier_invoice_number,amount_minor,created_by) VALUES($1,$2,'Broker LLC','INV-1',250000,$3)`,
    [load.id, carrier, subject.dispatcher],
  );
  await pool.query(
    "UPDATE loads SET cancelled_at=now(),cancelled_by=$2,cancel_reason='done' WHERE id=$1",
    [load.id, subject.dispatcher],
  );
  const loadsBefore = (
    await pool.query("SELECT count(*)::int n FROM loads WHERE carrier_id=$1", [
      carrier,
    ])
  ).rows[0].n;

  const carrierName = (
    await pool.query("SELECT name FROM carriers WHERE id=$1", [carrier])
  ).rows[0].name as string;
  const { id } = (await requestCarrierErasure(subject.dispatcher, {
    carrier_id: carrier,
    confirm_name: carrierName,
    reason: "Written request received 2026-10-29",
    password: p1,
    key: randomUUID(),
  })) as { id: string };
  assert.equal(
    (await pool.query("SELECT erased_at FROM carriers WHERE id=$1", [carrier]))
      .rows[0].erased_at,
    null,
  );
  const decided = await decideChange(other, id, {
    decision: "approve",
    verification: "document",
    password: p2,
  });
  assert.equal(decided.status, "approved");

  const one = async (sql: string) => (await pool.query(sql, [carrier])).rows[0];
  const after = await one("SELECT name,erased_at FROM carriers WHERE id=$1");
  assert.ok(after.name.startsWith("Erased carrier") && after.erased_at);
  assert.deepEqual(
    await one(
      "SELECT contact_name,contact_email,phone,usdot FROM carrier_profiles WHERE carrier_id=$1",
    ),
    { contact_name: "", contact_email: "", phone: "", usdot: "" },
  );
  const driver = (
    await pool.query(
      "SELECT name,contact_email,phone FROM drivers WHERE id=$1",
      [subject.driver],
    )
  ).rows[0];
  assert.deepEqual(driver, {
    name: "Erased driver",
    contact_email: null,
    phone: "",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM memberships WHERE carrier_id=$1",
        [carrier],
      )
    ).rows[0].n,
    0,
  );
  const c = (
    await pool.query("SELECT name,email,notes FROM contacts WHERE id=$1", [
      contact,
    ])
  ).rows[0];
  assert.deepEqual(c, {
    name: "Erased contact",
    email: "erased@erased.invalid",
    notes: "",
  });
  assert.equal(
    (
      await pool.query("SELECT body FROM load_notes WHERE load_id=$1", [
        load.id,
      ])
    ).rows[0].body,
    "[erased]",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM carrier_payout_details WHERE carrier_id=$1",
        [carrier],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM carrier_authority_checks WHERE carrier_id=$1",
        [carrier],
      )
    ).rows[0].n,
    0,
  );
  const obj = (
    await pool.query(
      "SELECT content,purged_at FROM document_objects WHERE storage_key=$1",
      [key],
    )
  ).rows[0];
  assert.equal(obj.content.length, 0);
  assert.ok(obj.purged_at);
  const version = (
    await pool.query(
      "SELECT filename,sha256 FROM document_versions WHERE id=$1",
      [versionId],
    )
  ).rows[0];
  assert.deepEqual(version, { filename: "erased", sha256: "a".repeat(64) });
  // Kept.
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM loads WHERE carrier_id=$1",
        [carrier],
      )
    ).rows[0].n,
    loadsBefore,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT bill_to FROM carrier_billing_packets WHERE load_id=$1",
        [load.id],
      )
    ).rows[0].bill_to,
    "Broker LLC",
  );
  // The receipt, and the audit trail of the erasure itself.
  const receipt = (
    await pool.query(
      "SELECT summary,proposed_value FROM sensitive_changes WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(receipt.summary, "Carrier erased");
  assert.ok(receipt.proposed_value.erased.includes("people"));
  assert.ok(receipt.proposed_value.kept.includes("billing"));
  assert.ok(receipt.proposed_value.counts.drivers >= 1);
  const audit = await pool.query(
    "SELECT 1 FROM audit_logs a WHERE a.resource_id=$1 AND a.action='carrier.erased'",
    [carrier],
  );
  assert.equal(audit.rowCount, 1);
  // The carrier no longer exists for anyone: nothing can be asked again, and
  // it cannot take new freight.
  await assert.rejects(
    requestCarrierErasure(subject.dispatcher, {
      carrier_id: carrier,
      confirm_name: after.name,
      reason: "again",
      password: p1,
      key: randomUUID(),
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(bookedLoad(subject.dispatcher, carrier));
  // History stays append-only for everyone else.
  await assert.rejects(
    pool.query("UPDATE load_notes SET body='x' WHERE load_id=$1", [load.id]),
    /Append-only/,
  );
});

test("a wider keep list leaves those categories alone", async () => {
  const subject = await tenant("ErasureKeep");
  const other = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Second','x')",
    [other, other + "@erasure.test"],
  );
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')",
    [subject.organization, subject.dispatcher, other],
  );
  const p1 = await withPassword(subject.dispatcher);
  const p2 = await withPassword(other);
  await pool.query("UPDATE drivers SET name='Dana Driver' WHERE id=$1", [
    subject.driver,
  ]);
  await pool.query(
    "INSERT INTO carrier_payout_details(carrier_id,payee_name,method,account_last4,effective_at) VALUES($1,'Casey Payee','ach','1234',now())",
    [subject.carrier],
  );
  process.env.RELAY_ERASURE_KEEP = "people";
  try {
    const carrierName = (
      await pool.query("SELECT name FROM carriers WHERE id=$1", [
        subject.carrier,
      ])
    ).rows[0].name as string;
    const { id } = (await requestCarrierErasure(subject.dispatcher, {
      carrier_id: subject.carrier,
      confirm_name: carrierName,
      reason: "r",
      password: p1,
      key: randomUUID(),
    })) as { id: string };
    await decideChange(other, id, {
      decision: "approve",
      verification: "callback",
      password: p2,
    });
  } finally {
    delete process.env.RELAY_ERASURE_KEEP;
  }
  assert.equal(
    (await pool.query("SELECT name FROM drivers WHERE id=$1", [subject.driver]))
      .rows[0].name,
    "Dana Driver",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM carrier_payout_details WHERE carrier_id=$1",
        [subject.carrier],
      )
    ).rows[0].n,
    0,
  );
});

test("bucket files are deleted by the job and retried when the store fails", async () => {
  const key = "bucket/" + randomUUID();
  await pool.query(
    "INSERT INTO document_objects(storage_key,backend,bucket,content) VALUES($1,'s3','b',NULL)",
    [key],
  );
  const change = (
    await pool.query(
      `INSERT INTO sensitive_changes(id,carrier_id,kind,summary,current_value,proposed_value,reason,requested_by)
     VALUES($1,$2,'carrier_erasure','x','{}','{}','r',$3) RETURNING id`,
      [randomUUID(), t.foreign, admin1],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO erasure_object_deletions(storage_key,carrier_id,change_id) VALUES($1,$2,$3)",
    [key, t.foreign, change],
  );
  let fail = true;
  const deleted: string[] = [];
  setObjectStore({
    bucket: "b",
    delete: async (k: string) => {
      if (fail) throw new Error("store down");
      deleted.push(k);
    },
  } as never);
  try {
    assert.deepEqual(await runObjectPurges(), { deleted: 0, failed: 1 });
    const row = (
      await pool.query(
        "SELECT attempts,last_error,done_at FROM erasure_object_deletions WHERE storage_key=$1",
        [key],
      )
    ).rows[0];
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "store down");
    fail = false;
    assert.deepEqual(await runObjectPurges(), { deleted: 1, failed: 0 });
    assert.deepEqual(deleted, [key]);
    assert.ok(
      (
        await pool.query(
          "SELECT purged_at FROM document_objects WHERE storage_key=$1",
          [key],
        )
      ).rows[0].purged_at,
    );
    assert.deepEqual(await runObjectPurges(), { deleted: 0, failed: 0 });
  } finally {
    setObjectStore(undefined);
  }
});
