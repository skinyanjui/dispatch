import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET } from "../../src/app/api/[...path]/route";
import {
  emptyHash,
  presignUrl,
  sha256Hex,
  signRequest,
} from "../../src/lib/sigv4";
import { s3Client, setObjectStore } from "../../src/lib/storage";
import { clamdScanner, setScanner } from "../../src/lib/malware";
import { carrierDocuments, uploadDocument } from "../../src/lib/documents";
import { migratePostgresObjects } from "../../src/lib/document-storage-migration";
import { pdf, request, sessionFor, tenant } from "./fixtures";

// AWS example credentials from the S3 SigV4 documentation.
const aws = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
const eicar =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Minimal S3 behaviour: SigV4 header shape, payload checksum, write-once PUT,
 *  HEAD/GET, and presigned GET with response header overrides. */
const objects = new Map<string, { body: Buffer; sha256: string }>();
let s3Down = false;
let s3: Server;
let s3Url = "";
function startS3() {
  return new Promise<void>((resolve) => {
    s3 = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, "http://local");
      const key = decodeURIComponent(url.pathname);
      if (s3Down) return res.writeHead(500).end();
      const presigned = url.searchParams.has("X-Amz-Signature");
      const auth = req.headers.authorization || "";
      if (
        !presigned &&
        (!auth.startsWith(
          "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/",
        ) ||
          !auth.includes("SignedHeaders=") ||
          req.headers["x-amz-content-sha256"] !== sha256Hex(body))
      )
        return res.writeHead(403).end();
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && objects.has(key))
          return res.writeHead(412).end();
        objects.set(key, {
          body,
          sha256: String(req.headers["x-amz-meta-sha256"]),
        });
        return res.writeHead(200).end();
      }
      const object = objects.get(key);
      if (!object) return res.writeHead(404).end();
      res.writeHead(200, {
        "content-length": object.body.length,
        "x-amz-meta-sha256": object.sha256,
        ...(presigned
          ? {
              "content-disposition": url.searchParams.get(
                "response-content-disposition",
              )!,
              "content-type": url.searchParams.get("response-content-type")!,
            }
          : {}),
      });
      res.end(req.method === "HEAD" ? undefined : object.body);
    }).listen(0, "127.0.0.1", () => {
      const address = s3.address() as { port: number };
      s3Url = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}
/** clamd INSTREAM: reports EICAR as infected, "SCANNER-ERROR" as an error. */
let clamd: TcpServer;
let clamdPort = 0;
function startClamd() {
  return new Promise<void>((resolve) => {
    clamd = createTcpServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (d) => {
        buffer = Buffer.concat([buffer, Buffer.from(d)]);
        const header = Buffer.from("zINSTREAM\0");
        if (buffer.length < header.length) return;
        let offset = header.length;
        const parts: Buffer[] = [];
        while (offset + 4 <= buffer.length) {
          const size = buffer.readUInt32BE(offset);
          if (size === 0) {
            const content = Buffer.concat(parts).toString("latin1");
            socket.end(
              content.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")
                ? "stream: Eicar-Test-Signature FOUND\0"
                : content.includes("SCANNER-ERROR")
                  ? "INSTREAM size limit exceeded. ERROR\0"
                  : "stream: OK\0",
            );
            return;
          }
          if (offset + 4 + size > buffer.length) return;
          parts.push(buffer.subarray(offset + 4, offset + 4 + size));
          offset += 4 + size;
        }
      });
    }).listen(0, "127.0.0.1", () => {
      clamdPort = (clamd.address() as { port: number }).port;
      resolve();
    });
  });
}

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Storage");
  await startS3();
  await startClamd();
});
afterEach(() => {
  setObjectStore(undefined);
  setScanner(undefined);
  delete process.env.RELAY_REQUIRE_MALWARE_SCAN;
  s3Down = false;
});
after(async () => {
  s3.close();
  clamd.close();
  await pool.end();
});
const store = () =>
  s3Client({
    endpoint: s3Url,
    region: aws.region,
    bucket: "relay-docs",
    accessKeyId: aws.accessKeyId,
    secretAccessKey: aws.secretAccessKey,
    virtualHosted: false,
  });
const upload = (bytes: Buffer, type = "w9", key = randomUUID()) =>
  uploadDocument(
    t.manager,
    { carrier_id: t.carrier, type, idempotency_key: key },
    { name: "file.pdf", bytes },
  );
const countVersions = async () =>
  (
    await pool.query(
      "SELECT count(*)::int n FROM document_versions WHERE carrier_id=$1",
      [t.carrier],
    )
  ).rows[0].n;

test("SigV4 matches the published AWS S3 examples", () => {
  const date = new Date("2013-05-24T00:00:00Z");
  const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
  assert.match(
    presignUrl(aws, "GET", url, 86400, date),
    /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
  );
  assert.match(
    signRequest(aws, "GET", url, { range: "bytes=0-9" }, emptyHash, date)
      .authorization,
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
});

test("clean scans are recorded; infected files are rejected and never stored", async () => {
  setScanner(clamdScanner("127.0.0.1", clamdPort, 2000));
  const clean = await upload(pdf());
  const before = await countVersions();
  const infected = Buffer.concat([pdf(), Buffer.from("\n" + eicar)]);
  await assert.rejects(upload(infected, "insurance_cargo"), {
    name: "ZodError",
  });
  await assert.rejects(upload(infected), { code: "MALWARE_DETECTED" });
  assert.equal(await countVersions(), before);
  const log = await pool.query(
    "SELECT verdict,signature,version_id FROM document_scans WHERE carrier_id=$1 ORDER BY scanned_at",
    [t.carrier],
  );
  assert.deepEqual(
    log.rows.map((r) => [r.verdict, r.signature, Boolean(r.version_id)]),
    [
      ["clean", null, true],
      ["infected", "Eicar-Test-Signature", false],
    ],
  );
  const objectsStored = await pool.query(
    "SELECT 1 FROM document_objects WHERE content=$1",
    [infected],
  );
  assert.equal(objectsStored.rowCount, 0);
  const events = await pool.query(
    "SELECT 1 FROM onboarding_events WHERE carrier_id=$1 AND type='document.malware_rejected'",
    [t.carrier],
  );
  assert.equal(events.rowCount, 1);
  const slot = (await carrierDocuments(t.manager, t.carrier)).slots.find(
    (s) => s.type === "w9",
  )!;
  assert.equal(slot.current?.id, clean.version_id);
  assert.equal(slot.current?.scan?.verdict, "clean");
  assert.equal(slot.current?.scan?.engine, "clamav");
});

test("scanning fails closed: scanner errors, outages and a required-but-missing scanner store nothing", async () => {
  const before = await countVersions();
  setScanner(clamdScanner("127.0.0.1", clamdPort, 2000));
  await assert.rejects(
    upload(Buffer.concat([pdf(), Buffer.from("SCANNER-ERROR")])),
    { code: "SCAN_UNAVAILABLE" },
  );
  setScanner(clamdScanner("127.0.0.1", 1, 2000)); // nothing listens on port 1
  await assert.rejects(upload(pdf()), { code: "SCAN_UNAVAILABLE" });
  setScanner(null);
  process.env.RELAY_REQUIRE_MALWARE_SCAN = "true";
  await assert.rejects(upload(pdf()), { code: "SCAN_UNAVAILABLE" });
  assert.equal(await countVersions(), before);
  delete process.env.RELAY_REQUIRE_MALWARE_SCAN;
  const unscanned = await upload(pdf());
  const slot = (await carrierDocuments(t.manager, t.carrier)).slots.find(
    (s) => s.type === "w9",
  )!;
  assert.equal(slot.current?.id, unscanned.version_id);
  assert.equal(slot.current?.scan, null);
});

test("object storage: bytes go to the bucket, downloads redirect to a short-lived signed URL", async () => {
  setObjectStore(store());
  const bytes = pdf();
  const key = randomUUID();
  const created = await upload(bytes, "w9", key);
  const row = await pool.query(
    "SELECT o.backend,o.bucket,o.content,o.storage_key FROM document_objects o JOIN document_versions v ON v.storage_key=o.storage_key WHERE v.id=$1",
    [created.version_id],
  );
  assert.equal(row.rows[0].backend, "s3");
  assert.equal(row.rows[0].bucket, "relay-docs");
  assert.equal(row.rows[0].content, null);
  assert.deepEqual(
    objects.get("/relay-docs/" + row.rows[0].storage_key)?.body,
    bytes,
  );
  // An exact retry replays without touching the bucket again.
  assert.deepEqual(await upload(bytes, "w9", key), created);
  const token = await sessionFor(t.manager);
  const response = await GET(
    request("documents/" + created.version_id + "/content", { token }),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const signed = new URL(response.headers.get("location")!);
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "60");
  assert.match(
    signed.searchParams.get("response-content-disposition")!,
    /^attachment;/,
  );
  const file = await fetch(signed);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.match(file.headers.get("content-disposition")!, /file\.pdf$/);
  const foreign = await sessionFor(t.foreignManager);
  const denied = await GET(
    request("documents/" + created.version_id + "/content", {
      token: foreign,
    }),
  );
  assert.equal(denied.status, 404);
  // Without a configured bucket, bucket-held files are unavailable, not lost.
  setObjectStore(null);
  const missing = await GET(
    request("documents/" + created.version_id + "/content", { token }),
  );
  assert.equal(missing.status, 503);
});

test("bucket outages and key collisions never record a version", async () => {
  setObjectStore(store());
  const before = await countVersions();
  s3Down = true;
  await assert.rejects(upload(pdf()), { code: "STORAGE_UNAVAILABLE" });
  s3Down = false;
  const key = randomUUID();
  objects.set(`/relay-docs/documents/${t.carrier}/${t.manager}/${key}`, {
    body: Buffer.from("other"),
    sha256: "0".repeat(64),
  });
  await assert.rejects(upload(pdf(), "w9", key), {
    code: "STORAGE_UNAVAILABLE",
  });
  assert.equal(await countVersions(), before);
});

test("existing PostgreSQL objects migrate to the bucket once, verified, and stay guarded", async () => {
  setObjectStore(null);
  const bytes = pdf();
  const created = await upload(bytes);
  const key = (
    await pool.query("SELECT storage_key FROM document_versions WHERE id=$1", [
      created.version_id,
    ])
  ).rows[0].storage_key;
  let result;
  do result = await migratePostgresObjects(store(), 1000);
  while (result.remaining);
  const row = await pool.query(
    "SELECT backend,content,migrated_at FROM document_objects WHERE storage_key=$1",
    [key],
  );
  assert.equal(row.rows[0].backend, "s3");
  assert.equal(row.rows[0].content, null);
  assert.ok(row.rows[0].migrated_at);
  assert.deepEqual(objects.get("/relay-docs/" + key)?.body, bytes);
  assert.equal((await migratePostgresObjects(store(), 1000)).moved, 0);
  await assert.rejects(
    pool.query(
      "UPDATE document_objects SET backend='postgres',content='x',bucket=NULL WHERE storage_key=$1",
      [key],
    ),
    /Append-only record/,
  );
  await assert.rejects(
    pool.query("DELETE FROM document_objects WHERE storage_key=$1", [key]),
    /Append-only record/,
  );
});
