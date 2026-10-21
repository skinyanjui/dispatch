import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { setObjectStore } from "../../src/lib/storage";
import { clamdScanner, setScanner } from "../../src/lib/malware";
import {
  createUploadSession,
  finalizeUpload,
  uploadDocument,
} from "../../src/lib/documents";
import {
  maxDirectUploadBytes,
  maxDocumentBytes,
} from "../../src/lib/compliance";
import { eicar, startFakeClamd, startFakeS3 } from "./fakes";
import { pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
let s3: Awaited<ReturnType<typeof startFakeS3>>;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
before(async () => {
  t = await tenant("Direct");
  s3 = await startFakeS3();
  clamd = await startFakeClamd();
});
afterEach(() => {
  setObjectStore(undefined);
  setScanner(undefined);
  delete process.env.RELAY_REQUIRE_MALWARE_SCAN;
  s3.state.down = false;
});
after(async () => {
  s3.close();
  clamd.close();
  await pool.end();
});

/** A PDF larger than the 4 MiB server limit. */
const large = (extra = Buffer.alloc(0), size = maxDocumentBytes + 1024) =>
  Buffer.concat([pdf(), extra, Buffer.alloc(size, 0x20)]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const declare = (bytes: Buffer, extra: Record<string, unknown> = {}) => ({
  carrier_id: t.carrier,
  type: "w9",
  idempotency_key: randomUUID(),
  filename: "scan.pdf",
  size_bytes: bytes.length,
  sha256: sha(bytes),
  ...extra,
});
/** The browser's step: PUT to the presigned URL exactly as returned. */
async function put(
  session: { upload_url: string; upload_headers: Record<string, string> },
  bytes: Buffer,
) {
  return fetch(session.upload_url, {
    method: "PUT",
    headers: session.upload_headers,
    body: new Uint8Array(bytes),
  });
}
const pending = async (input: Record<string, unknown>, user = t.manager) => {
  const session = await createUploadSession(user, input);
  assert.equal(session.status, "pending");
  return session as Extract<typeof session, { status: "pending" }>;
};
const countVersions = async () =>
  (
    await pool.query(
      "SELECT count(*)::int n FROM document_versions WHERE carrier_id=$1",
      [t.carrier],
    )
  ).rows[0].n;

test("large files go straight to a quarantine key, then are verified, scanned, copied and recorded", async () => {
  setObjectStore(s3.client());
  setScanner(clamdScanner("127.0.0.1", clamd.port, 2000));
  const bytes = large();
  const input = declare(bytes);
  const before = await countVersions();
  const session = await pending(input);
  // Presigned for exactly this size, in the quarantine prefix.
  const url = new URL(session.upload_url);
  assert.match(
    url.pathname,
    new RegExp(`/relay-docs/quarantine/${t.carrier}/`),
  );
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.ok(
    url.searchParams.get("X-Amz-SignedHeaders")!.includes("content-length"),
  );
  // A slot is not a document: nothing is recorded until finalize.
  assert.equal(await countVersions(), before);
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "UPLOAD_NOT_RECEIVED",
  });
  assert.equal((await put(session, bytes)).status, 200);
  const done = await finalizeUpload(t.manager, session.session_id);
  assert.equal(done.version, 1);
  const row = await pool.query(
    `SELECT v.size_bytes,v.content_type,o.backend,o.bucket,o.storage_key,
      (SELECT verdict FROM document_scans WHERE version_id=v.id) verdict
    FROM document_versions v JOIN document_objects o ON o.storage_key=v.storage_key WHERE v.id=$1`,
    [done.version_id],
  );
  assert.equal(row.rows[0].size_bytes, bytes.length);
  assert.equal(row.rows[0].backend, "s3");
  assert.equal(row.rows[0].verdict, "clean");
  assert.ok(row.rows[0].storage_key.startsWith("documents/"));
  assert.deepEqual(
    s3.objects.get("/relay-docs/" + row.rows[0].storage_key)?.body,
    bytes,
  );
  // Finalize is idempotent; the same request after completion replays.
  assert.deepEqual(await finalizeUpload(t.manager, session.session_id), done);
  assert.deepEqual(await createUploadSession(t.manager, input), {
    status: "finalized",
    ...done,
  });
  assert.equal(await countVersions(), before + 1);
  // Downloads of direct uploads use the usual signed redirect.
  const token = await sessionFor(t.manager);
  const download = await GET(
    request(`documents/${done.version_id}/content`, { token }),
  );
  assert.equal(download.status, 302);
});

test("a retried session request reuses the same upload slot; changed content conflicts", async () => {
  setObjectStore(s3.client());
  const bytes = large(Buffer.from("retry"));
  const input = declare(bytes);
  const first = await pending(input);
  const again = await pending(input);
  assert.equal(again.session_id, first.session_id);
  await assert.rejects(
    createUploadSession(t.manager, { ...input, size_bytes: bytes.length - 1 }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("size, checksum and type are re-verified from the stored bytes", async () => {
  setObjectStore(s3.client());
  const bytes = large(Buffer.from("verify"));
  // The browser cannot upload a different size: the presigned PUT is bound to it.
  const bound = await pending(declare(bytes));
  assert.equal(
    (await put(bound, bytes.subarray(0, bytes.length - 10))).status,
    403,
  );
  // Same size but different content: caught by the server-side checksum.
  const swapped = await pending(declare(bytes));
  const other = Buffer.from(bytes);
  other[other.length - 1] = 0x21;
  assert.equal((await put(swapped, other)).status, 200);
  await assert.rejects(finalizeUpload(t.manager, swapped.session_id), {
    code: "UPLOAD_CHECKSUM_MISMATCH",
  });
  // A rejected session stays rejected and its object never becomes a document.
  await assert.rejects(finalizeUpload(t.manager, swapped.session_id), {
    code: "UPLOAD_CHECKSUM_MISMATCH",
  });
  // Not a supported file type, whatever the filename says.
  const exe = Buffer.concat([
    Buffer.from("MZ\x90\x00"),
    Buffer.alloc(maxDocumentBytes + 10, 0x41),
  ]);
  const typed = await pending(declare(exe, { filename: "scan.pdf" }));
  await put(typed, exe);
  await assert.rejects(finalizeUpload(t.manager, typed.session_id), {
    code: "UNSUPPORTED_FILE_TYPE",
  });
});

test("infected direct uploads are rejected at finalize and never become versions", async () => {
  setObjectStore(s3.client());
  setScanner(clamdScanner("127.0.0.1", clamd.port, 2000));
  const infected = large(Buffer.from("\n" + eicar));
  const before = await countVersions();
  const session = await pending(declare(infected));
  await put(session, infected);
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "MALWARE_DETECTED",
  });
  assert.equal(await countVersions(), before);
  const status = await pool.query(
    "SELECT status,failure FROM document_upload_sessions WHERE id=$1",
    [session.session_id],
  );
  assert.deepEqual(status.rows[0], {
    status: "rejected",
    failure: "MALWARE_DETECTED",
  });
  const log = await pool.query(
    "SELECT verdict,version_id FROM document_scans WHERE carrier_id=$1 AND sha256=$2",
    [t.carrier, sha(infected)],
  );
  assert.deepEqual(log.rows, [{ verdict: "infected", version_id: null }]);
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "MALWARE_DETECTED",
  });
});

test("scanner and storage outages leave the session pending so the same upload can be retried", async () => {
  setObjectStore(s3.client());
  const bytes = large(Buffer.from("outage"));
  const session = await pending(declare(bytes));
  await put(session, bytes);
  setScanner(clamdScanner("127.0.0.1", 1, 1000)); // nothing listens on port 1
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "SCAN_UNAVAILABLE",
  });
  process.env.RELAY_REQUIRE_MALWARE_SCAN = "true";
  setScanner(null);
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "SCAN_UNAVAILABLE",
  });
  delete process.env.RELAY_REQUIRE_MALWARE_SCAN;
  setScanner(clamdScanner("127.0.0.1", clamd.port, 2000));
  s3.state.down = true;
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "STORAGE_UNAVAILABLE",
  });
  s3.state.down = false;
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM document_upload_sessions WHERE id=$1",
        [session.session_id],
      )
    ).rows[0].status,
    "pending",
  );
  const recovered = await finalizeUpload(t.manager, session.session_id);
  assert.ok(recovered.version_id);
});

test("authorization, limits and configuration are enforced before and after the upload", async () => {
  const bytes = large(Buffer.from("auth"));
  // Without a bucket there is no direct path.
  setObjectStore(null);
  await assert.rejects(createUploadSession(t.manager, declare(bytes)), {
    code: "DIRECT_UPLOAD_UNAVAILABLE",
  });
  setObjectStore(s3.client());
  await assert.rejects(
    createUploadSession(
      t.manager,
      declare(bytes, { size_bytes: maxDirectUploadBytes + 1 }),
    ),
    { name: "ZodError" },
  );
  await assert.rejects(
    createUploadSession(t.manager, declare(bytes, { sha256: "not-a-hash" })),
    { name: "ZodError" },
  );
  await assert.rejects(createUploadSession(t.foreignManager, declare(bytes)), {
    code: "NOT_FOUND",
  });
  await assert.rejects(createUploadSession(t.driverUser, declare(bytes)), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    createUploadSession(t.manager, declare(bytes, { type: "insurance_cargo" })),
    { name: "ZodError" },
  );
  // Another user cannot finalize someone else's session, even with its ID.
  const session = await pending(declare(bytes));
  await put(session, bytes);
  await assert.rejects(finalizeUpload(t.foreignManager, session.session_id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(finalizeUpload(t.dispatcher, session.session_id), {
    code: "NOT_FOUND",
  });
  // An expired session cannot be finalized.
  await pool.query(
    "UPDATE document_upload_sessions SET created_at=now()-interval '3 hours' WHERE id=$1",
    [session.session_id],
  );
  await assert.rejects(finalizeUpload(t.manager, session.session_id), {
    code: "UPLOAD_EXPIRED",
  });
  // Access lost after the session began is re-checked at finalize.
  const revoked = await pending(declare(large(Buffer.from("revoked"))));
  await put(revoked, large(Buffer.from("revoked")));
  await pool.query(
    "DELETE FROM memberships WHERE user_id=$1 AND carrier_id=$2",
    [t.manager, t.carrier],
  );
  try {
    await assert.rejects(finalizeUpload(t.manager, revoked.session_id), {
      code: "NOT_FOUND",
    });
  } finally {
    await pool.query(
      "INSERT INTO memberships VALUES($1,$2,'carrier-manager',NULL)",
      [t.manager, t.carrier],
    );
  }
});

test("HTTP flow and the small-file path keep working alongside direct uploads", async () => {
  setObjectStore(s3.client());
  const token = await sessionFor(t.manager);
  const bytes = large(Buffer.from("http"));
  const created = await POST(
    request("documents/uploads", {
      token,
      json: declare(bytes, { type: "dispatch_agreement" }),
    }),
  );
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal(session.status, "pending");
  assert.equal((await put(session, bytes)).status, 200);
  const finalized = await POST(
    request(`documents/uploads/${session.session_id}/finalize`, {
      token,
      json: {},
    }),
  );
  assert.equal(finalized.status, 201);
  const denied = await POST(
    request(`documents/uploads/${session.session_id}/finalize`, {
      token: await sessionFor(t.foreignManager),
      json: {},
    }),
  );
  assert.equal(denied.status, 404);
  assert.equal(
    (await POST(request("documents/uploads", { json: declare(bytes) }))).status,
    401,
  );
  // The 4 MiB server path is unchanged, and still refuses oversized bodies.
  const small = await uploadDocument(
    t.manager,
    { carrier_id: t.carrier, type: "w9", idempotency_key: randomUUID() },
    { name: "small.pdf", bytes: pdf() },
  );
  assert.ok(small.version_id);
  await assert.rejects(
    uploadDocument(
      t.manager,
      { carrier_id: t.carrier, type: "w9", idempotency_key: randomUUID() },
      { name: "big.pdf", bytes: large() },
    ),
    { code: "FILE_TOO_LARGE" },
  );
});
