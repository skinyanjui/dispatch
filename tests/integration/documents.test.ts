import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  carrierDocuments,
  documentContent,
  reviewDocument,
  uploadDocument,
} from "../../src/lib/documents";
import { detail, mutate } from "../../src/lib/loads";
import { saveAgreement } from "../../src/lib/onboarding";
import { documentStatus } from "../../src/lib/compliance";
import type { Load } from "../../src/lib/contracts";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Documents");
});
after(() => pool.end());

const upload = (
  user: string,
  fields: Record<string, string>,
  bytes = pdf(),
  name = "scan.pdf",
) =>
  uploadDocument(
    user,
    { idempotency_key: randomUUID(), ...fields },
    { name, bytes },
  );

test("document status derives from latest version, review and expiry", () => {
  const today = "2026-10-21";
  const accepted = {
    decision: "accepted" as const,
    note: "",
    reviewer_name: "QA",
    created_at: today,
  };
  assert.equal(documentStatus(null, today), "missing");
  assert.equal(
    documentStatus({ expires_on: null, review: null }, today),
    "pending_review",
  );
  assert.equal(
    documentStatus({ expires_on: "2026-10-20", review: accepted }, today),
    "expired",
  );
  assert.equal(
    documentStatus({ expires_on: "2026-11-20", review: accepted }, today),
    "expiring",
  );
  assert.equal(
    documentStatus({ expires_on: "2026-11-21", review: accepted }, today),
    "accepted",
  );
  assert.equal(
    documentStatus(
      { expires_on: null, review: { ...accepted, decision: "rejected" } },
      today,
    ),
    "rejected",
  );
});

test("carrier files version immutably, dedupe retries and require dispatcher review", async () => {
  const key = randomUUID();
  const bytes = pdf();
  const fields = {
    carrier_id: t.carrier,
    type: "insurance_cargo",
    expires_on: "2099-01-01",
    idempotency_key: key,
  };
  const first = await uploadDocument(t.manager, fields, {
    name: "../../etc/cargo.pdf",
    bytes,
  });
  assert.equal(first.version, 1);
  const retry = await uploadDocument(t.manager, fields, {
    name: "../../etc/cargo.pdf",
    bytes,
  });
  assert.deepEqual(retry, first);
  await assert.rejects(
    uploadDocument(t.manager, fields, { name: "other.pdf", bytes }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    upload(t.manager, { ...fields, idempotency_key: randomUUID() }, bytes),
    { code: "DUPLICATE_DOCUMENT_VERSION" },
  );
  await assert.rejects(
    reviewDocument(t.manager, first.version_id, { decision: "accepted" }),
    { code: "DISPATCHER_REVIEW_REQUIRED" },
  );
  await assert.rejects(
    reviewDocument(t.dispatcher, first.version_id, { decision: "rejected" }),
    { name: "ZodError" },
  );
  await reviewDocument(t.dispatcher, first.version_id, {
    decision: "rejected",
    note: "Certificate holder is wrong",
  });
  const second = await upload(t.manager, {
    carrier_id: t.carrier,
    type: "insurance_cargo",
    expires_on: "2099-01-01",
  });
  assert.equal(second.version, 2);
  await assert.rejects(
    reviewDocument(t.dispatcher, first.version_id, { decision: "accepted" }),
    { code: "DOCUMENT_SUPERSEDED" },
  );
  await reviewDocument(t.dispatcher, second.version_id, {
    decision: "accepted",
  });
  const view = await carrierDocuments(t.manager, t.carrier);
  const cargo = view.slots.find((s) => s.type === "insurance_cargo")!;
  assert.equal(cargo.status, "accepted");
  assert.equal(cargo.history.length, 2);
  assert.equal(cargo.history[1].filename, "cargo.pdf");
  assert.equal(cargo.history[1].review?.decision, "rejected");
  assert.equal(view.slots.find((s) => s.type === "w9")!.status, "missing");
  await assert.rejects(
    pool.query("UPDATE document_versions SET filename='x' WHERE id=$1", [
      first.version_id,
    ]),
    /Append-only record/,
  );
  await assert.rejects(
    pool.query("DELETE FROM document_objects WHERE storage_key LIKE $1", [
      "documents/" + t.carrier + "/%",
    ]),
    /Append-only record/,
  );
  const file = await documentContent(t.dispatcher, first.version_id);
  assert.ok(file.kind === "inline");
  assert.deepEqual(file.content, bytes);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE actor_id=$1 AND action='document.downloaded' AND resource_id=$2",
        [t.dispatcher, first.version_id],
      )
    ).rowCount,
    1,
  );
});

test("uploads validate content, metadata and size", async () => {
  await assert.rejects(
    upload(
      t.manager,
      { carrier_id: t.carrier, type: "w9" },
      Buffer.from("MZ\x90\x00 executable"),
    ),
    { code: "UNSUPPORTED_FILE_TYPE" },
  );
  await assert.rejects(
    upload(
      t.manager,
      { carrier_id: t.carrier, type: "w9" },
      Buffer.concat([pdf(), Buffer.alloc(4 * 1024 * 1024)]),
    ),
    { code: "FILE_TOO_LARGE" },
  );
  await assert.rejects(
    upload(t.manager, {
      carrier_id: t.carrier,
      type: "insurance_auto_liability",
    }),
    { name: "ZodError" },
  );
  await assert.rejects(
    upload(t.manager, { carrier_id: t.carrier, type: "pod" }),
    { name: "ZodError" },
  );
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(randomUUID()),
  ]);
  const w9 = await upload(
    t.manager,
    { carrier_id: t.carrier, type: "w9" },
    png,
    "w9.pdf",
  );
  const { rows } = await pool.query(
    "SELECT content_type FROM document_versions WHERE id=$1",
    [w9.version_id],
  );
  assert.equal(rows[0].content_type, "image/png");
});

test("document access is carrier- and assignment-scoped, including guessed IDs", async () => {
  const mine = await bookedLoad(t.dispatcher, t.carrier);
  const foreign = await bookedLoad(t.dispatcher, t.foreign);
  await mutate(t.dispatcher, mine.id, "assign", {
    version: 1,
    driverId: t.driver,
  });
  const foreignFile = await upload(t.foreignManager, {
    carrier_id: t.foreign,
    type: "w9",
  });
  // Manager of one carrier cannot read, review or upload into another.
  await assert.rejects(documentContent(t.manager, foreignFile.version_id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(carrierDocuments(t.manager, t.foreign), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    upload(t.manager, { carrier_id: t.foreign, type: "w9" }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    upload(t.manager, {
      carrier_id: t.carrier,
      load_id: foreign.id,
      type: "bol",
    }),
    { code: "NOT_FOUND" },
  );
  // Drivers: BOL/POD on assigned loads only; no carrier compliance files.
  const bol = await upload(t.driverUser, {
    carrier_id: t.carrier,
    load_id: mine.id,
    type: "bol",
  });
  await assert.rejects(
    upload(t.driverUser, {
      carrier_id: t.carrier,
      load_id: mine.id,
      type: "rate_confirmation",
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    upload(t.otherDriverUser, {
      carrier_id: t.carrier,
      load_id: mine.id,
      type: "pod",
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    upload(t.driverUser, { carrier_id: t.carrier, type: "w9" }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(carrierDocuments(t.driverUser, t.carrier), {
    code: "NOT_FOUND",
  });
  assert.ok(await documentContent(t.driverUser, bol.version_id));
  await assert.rejects(documentContent(t.otherDriverUser, bol.version_id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    reviewDocument(t.driverUser, bol.version_id, { decision: "accepted" }),
    { code: "NOT_FOUND" },
  );
  const view = (await detail(t.dispatcher, mine.id)) as Load;
  assert.equal(
    view.documents!.find((d) => d.type === "bol")?.status,
    "pending_review",
  );
  assert.equal(
    view.documents!.find((d) => d.type === "pod")?.status,
    "missing",
  );
  const events = await pool.query(
    "SELECT type FROM load_events WHERE load_id=$1 ORDER BY created_at",
    [mine.id],
  );
  assert.ok(events.rows.some((e) => e.type === "document.uploaded"));
});

test("HTTP upload, download headers and cross-carrier denial", async () => {
  const token = await sessionFor(t.manager);
  const body = new FormData();
  body.set("carrier_id", t.carrier);
  body.set("type", "dispatch_agreement");
  body.set("idempotency_key", randomUUID());
  body.set("file", new Blob([new Uint8Array(pdf())]), "Signed agreement.pdf");
  const created = await POST(request("documents", { token, body }));
  assert.equal(created.status, 201);
  const { version_id } = await created.json();
  const download = await GET(
    request("documents/" + version_id + "/content", { token }),
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.match(
    download.headers.get("content-disposition")!,
    /^attachment; .*Signed%20agreement\.pdf$/,
  );
  const json = await POST(
    request("documents", { token, json: { carrier_id: t.carrier } }),
  );
  assert.equal(json.status, 415);
  const foreignToken = await sessionFor(t.foreignManager);
  const denied = await GET(
    request("documents/" + version_id + "/content", { token: foreignToken }),
  );
  assert.equal(denied.status, 404);
  const anonymous = await GET(request("documents/" + version_id + "/content"));
  assert.equal(anonymous.status, 401);
});

test("agreement verification links the exact latest uploaded file", async () => {
  const older = await upload(t.dispatcher, {
    carrier_id: t.carrier,
    type: "dispatch_agreement",
  });
  const latest = await upload(t.dispatcher, {
    carrier_id: t.carrier,
    type: "dispatch_agreement",
  });
  const foreignFile = await upload(t.dispatcher, {
    carrier_id: t.foreign,
    type: "dispatch_agreement",
  });
  const input = (document_version_id: string) => ({
    key: randomUUID(),
    reference: "Fictional dispatch services agreement",
    effective_date: "2026-01-01",
    through_date: "2099-12-31",
    confirmed: true as const,
    document_version_id,
  });
  for (const id of [older.version_id, foreignFile.version_id])
    await assert.rejects(saveAgreement(t.dispatcher, t.carrier, input(id)), {
      code: "AGREEMENT_FILE_UNAVAILABLE",
    });
  await assert.rejects(
    saveAgreement(t.manager, t.carrier, input(latest.version_id)),
    { code: "NOT_FOUND" },
  );
  await saveAgreement(t.dispatcher, t.carrier, input(latest.version_id));
  const view = await carrierDocuments(t.dispatcher, t.carrier);
  assert.equal(view.agreement?.document_version_id, latest.version_id);
  assert.equal(
    view.slots.find((s) => s.type === "dispatch_agreement")?.status,
    "accepted",
  );
});
