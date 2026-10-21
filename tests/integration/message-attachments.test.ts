import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { getThread, sendMessage, visibleThread } from "../../src/lib/messaging";
import {
  attachmentContent,
  uploadAttachment,
} from "../../src/lib/message-attachments";
import { clamdScanner, setScanner } from "../../src/lib/malware";
import { eicar, startFakeClamd } from "./fakes";
import { request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
let t: Awaited<ReturnType<typeof tenant>>;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
before(async () => {
  t = await tenant("Attach");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
  clamd = await startFakeClamd();
});
after(async () => {
  setScanner(undefined);
  clamd.close();
  await pool.end();
});

const pdf = (label: string) => ({
  name: label + ".pdf",
  bytes: Buffer.from(`%PDF-1.4\n% fictional ${label} ${randomUUID()}\n%%EOF\n`),
});
const msg = (over: Record<string, unknown> = {}) => ({
  idempotency_key: randomUUID(),
  subject: "Rate confirmation",
  to: ["user:" + t.manager],
  channel: "in_app",
  body: "Signed copy attached",
  ...over,
});
const download = (user: string, id: string) =>
  attachmentContent(user, id, visibleThread);

test("a file is attached once, readable by the conversation, hidden from everyone else", async () => {
  const file = await uploadAttachment(t.dispatcher, pdf("Rate con"));
  assert.equal(file.content_type, "application/pdf");
  // Before sending only the uploader can open it.
  assert.equal((await download(t.dispatcher, file.id)).kind, "inline");
  await assert.rejects(download(t.manager, file.id), { code: "NOT_FOUND" });
  // Other people cannot attach someone else's upload.
  await assert.rejects(
    sendMessage(
      t.manager,
      msg({ to: ["user:" + t.dispatcher], attachment_ids: [file.id] }),
    ),
    { code: "NOT_FOUND" },
  );
  const sent = await sendMessage(
    t.dispatcher,
    msg({ attachment_ids: [file.id] }),
  );
  const view = await getThread(t.manager, sent.thread_id);
  assert.deepEqual(
    view.messages[0].attachments.map((a: { id: string }) => a.id),
    [file.id],
  );
  const got = await download(t.manager, file.id);
  assert.equal(got.kind, "inline");
  if (got.kind === "inline") assert.match(got.content.toString(), /%PDF/);
  // Not the other carrier's manager, a driver outside the thread, or a guessed id.
  for (const user of [t.foreignManager, t.driverUser])
    await assert.rejects(download(user, file.id), { code: "NOT_FOUND" });
  await assert.rejects(download(t.manager, randomUUID()), {
    code: "NOT_FOUND",
  });
  // A file attaches to one message only.
  await assert.rejects(
    sendMessage(t.dispatcher, msg({ attachment_ids: [file.id] })),
    { code: "NOT_FOUND" },
  );
  // The link is permanent.
  await assert.rejects(
    pool.query(
      "UPDATE message_attachments SET message_id=NULL,linked_at=NULL WHERE id=$1",
      [file.id],
    ),
  );
  const audits = await pool.query(
    "SELECT action FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
    [file.id],
  );
  assert.ok(
    audits.rows.some((r) => r.action === "message_attachment.downloaded"),
  );
});

test("unsupported types, oversized files, texts and email are refused", async () => {
  await assert.rejects(
    uploadAttachment(t.dispatcher, {
      name: "x.exe",
      bytes: Buffer.from("MZ not allowed"),
    }),
    { code: "UNSUPPORTED_FILE_TYPE" },
  );
  await assert.rejects(
    uploadAttachment(t.dispatcher, {
      name: "big.pdf",
      bytes: Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(4 * 1024 * 1024),
      ]),
    }),
    { code: "FILE_TOO_LARGE" },
  );
  await assert.rejects(uploadAttachment(t.dispatcher, null), {
    code: "FILE_REQUIRED",
  });
  const file = await uploadAttachment(t.dispatcher, pdf("Email"));
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({ channel: "email", attachment_ids: [file.id] }),
    ),
    { code: "ATTACHMENTS_NOT_SUPPORTED" },
  );
  await assert.rejects(
    sendMessage(
      t.dispatcher,
      msg({ attachment_ids: Array.from({ length: 4 }, randomUUID) }),
    ),
    { name: "ZodError" },
  );
});

test("infected files are rejected and never stored", async () => {
  setScanner(clamdScanner("127.0.0.1", clamd.port, 2000));
  const clean = await uploadAttachment(t.dispatcher, pdf("Clean"));
  assert.ok(clean.id);
  const before = (
    await pool.query("SELECT count(*)::int n FROM message_attachments")
  ).rows[0].n;
  await assert.rejects(
    uploadAttachment(t.dispatcher, {
      name: "bad.pdf",
      bytes: Buffer.from("%PDF-1.4\n" + eicar),
    }),
    { code: "MALWARE_DETECTED" },
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM message_attachments"))
      .rows[0].n,
    before,
  );
  setScanner(clamdScanner("127.0.0.1", 1, 1000));
  await assert.rejects(uploadAttachment(t.dispatcher, pdf("Down")), {
    code: "SCAN_UNAVAILABLE",
  });
  setScanner(undefined);
});

test("HTTP: upload and download need a session and respect conversation access", async () => {
  assert.equal(
    (await GET(request("message-attachments/" + randomUUID()))).status,
    401,
  );
  const token = await sessionFor(t.dispatcher);
  const form = new FormData();
  form.set(
    "file",
    new Blob([pdf("Http").bytes], { type: "application/pdf" }),
    "http.pdf",
  );
  const up = await POST(request("message-attachments", { token, body: form }));
  assert.equal(up.status, 201);
  const { id } = await up.json();
  const sent = await sendMessage(t.dispatcher, msg({ attachment_ids: [id] }));
  void sent;
  const ok = await GET(
    request("message-attachments/" + id, {
      token: await sessionFor(t.manager),
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.match(ok.headers.get("content-disposition") || "", /^attachment/);
  const foreign = await GET(
    request("message-attachments/" + id, {
      token: await sessionFor(t.foreignManager),
    }),
  );
  assert.equal(foreign.status, 404);
});
