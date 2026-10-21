import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { event, member, scoped } from "./loads";
import { emit } from "./onboarding";
import { objectStore, StorageUnavailable } from "./storage";
import {
  configuredScanner,
  scanRequired,
  ScannerUnavailable,
  type ScanResult,
} from "./malware";
import {
  carrierDocumentTypes,
  cleanFilename,
  documentStatus,
  driverUploadTypes,
  expiringTypes,
  loadDocumentTypes,
  maxDirectUploadBytes,
  maxDocumentBytes,
  sniffContentType,
  todayUtc,
  type DocumentSlot,
  type DocumentType,
  type DocumentVersion,
} from "./compliance";

const allTypes = [...carrierDocumentTypes, ...loadDocumentTypes] as const;
export const uploadSchema = z
  .object({
    carrier_id: z.uuid(),
    load_id: z.uuid().optional(),
    type: z.enum(allTypes),
    expires_on: z.iso.date().optional(),
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
  })
  .strict()
  .superRefine((d, ctx) => {
    const loadType = (loadDocumentTypes as readonly string[]).includes(d.type);
    if (loadType !== Boolean(d.load_id))
      ctx.addIssue({
        code: "custom",
        message: "Load paperwork needs a load; compliance files must not",
      });
    if (expiringTypes.includes(d.type) !== Boolean(d.expires_on))
      ctx.addIssue({
        code: "custom",
        message: "Insurance needs an expiry date; other files must not",
      });
  });
export type UploadFile = { name: string; bytes: Buffer };

async function versions(
  c: PoolClient,
  where: string,
  params: unknown[],
): Promise<(DocumentVersion & { document_id: string; type: DocumentType })[]> {
  const { rows } = await c.query(
    `SELECT v.id,v.document_id,d.type,v.version,v.filename,v.content_type,v.size_bytes,
      to_char(v.expires_on,'YYYY-MM-DD') expires_on,v.uploaded_at,u.name uploader_name,
      (SELECT json_build_object('decision',r.decision,'note',r.note,'reviewer_name',ru.name,'created_at',r.created_at)
        FROM document_reviews r JOIN users ru ON ru.id=r.reviewer_id
        WHERE r.version_id=v.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) review,
      (SELECT json_build_object('verdict',sc.verdict,'engine',sc.engine,'scanned_at',sc.scanned_at)
        FROM document_scans sc WHERE sc.version_id=v.id ORDER BY sc.scanned_at DESC LIMIT 1) scan
    FROM document_versions v JOIN documents d ON d.id=v.document_id JOIN users u ON u.id=v.uploaded_by
    WHERE ${where} ORDER BY v.version DESC`,
    params,
  );
  return rows;
}
function slots(
  types: readonly DocumentType[],
  rows: Awaited<ReturnType<typeof versions>>,
): DocumentSlot[] {
  const today = todayUtc();
  return types.map((type) => {
    const history = rows
      .filter((r) => r.type === type)
      .map(({ document_id, type, ...v }) => {
        void document_id;
        void type;
        return v;
      });
    const current = history[0] ?? null;
    return {
      type,
      document_id: rows.find((r) => r.type === type)?.document_id ?? null,
      status: documentStatus(current, today),
      current,
      history: history.slice(0, 10),
    };
  });
}
export async function loadDocumentSlots(c: PoolClient, loadId: string) {
  return slots(loadDocumentTypes, await versions(c, "d.load_id=$1", [loadId]));
}
export async function carrierDocumentSlots(c: PoolClient, carrierId: string) {
  return slots(
    carrierDocumentTypes,
    await versions(c, "d.carrier_id=$1 AND d.load_id IS NULL", [carrierId]),
  );
}

/** Driver write access is limited to BOL/POD on loads assigned to them. */
async function authorizeLoadWrite(
  c: PoolClient,
  user: string,
  loadId: string,
  carrierId: string,
  type: DocumentType,
) {
  const load = await scoped(
    c,
    user,
    loadId,
    true,
    driverUploadTypes.includes(type),
  );
  if (load.carrier_id !== carrierId) throw new HttpError(404, "NOT_FOUND");
  const membership = await member(c, user, load.carrier_id);
  if (membership.role === "driver") {
    const assigned = await c.query(
      "SELECT 1 FROM load_assignments WHERE load_id=$1 AND driver_id=$2",
      [loadId, membership.driver_id],
    );
    if (!assigned.rowCount) throw new HttpError(404, "NOT_FOUND");
  }
  return load;
}

async function authorizeUpload(
  c: PoolClient,
  user: string,
  data: z.infer<typeof uploadSchema>,
) {
  const load = data.load_id
    ? await authorizeLoadWrite(
        c,
        user,
        data.load_id,
        data.carrier_id,
        data.type,
      )
    : null;
  if (!load) await member(c, user, data.carrier_id, true);
  return load;
}
async function replay(c: PoolClient, user: string, key: string, hash: string) {
  const old = await c.query(
    "SELECT id,document_id,version,request_hash FROM document_versions WHERE uploaded_by=$1 AND idempotency_key=$2",
    [user, key],
  );
  if (!old.rows[0]) return null;
  if (old.rows[0].request_hash !== hash)
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return {
    document_id: old.rows[0].document_id as string,
    version_id: old.rows[0].id as string,
    version: old.rows[0].version as number,
  };
}
const slotFilter = (loadId?: string) =>
  loadId ? "load_id=$3" : "load_id IS NULL";

type Upload = z.infer<typeof uploadSchema>;
const slotParams = (data: Upload) =>
  data.load_id
    ? [data.carrier_id, data.type, data.load_id]
    : [data.carrier_id, data.type];
/** Version request hash; identical for proxied and direct uploads. */
const uploadHash = (data: Upload, filename: string, sha256: string) => {
  const { idempotency_key, ...metadata } = data;
  void idempotency_key;
  return digest(JSON.stringify({ ...metadata, filename, sha256 }));
};

/** Authorize, replay a finished request, or refuse an unchanged re-upload. */
async function precheck(
  user: string,
  data: Upload,
  hash: string,
  sha256: string,
) {
  return transaction(async (c) => {
    await authorizeUpload(c, user, data);
    const previous = await replay(c, user, data.idempotency_key, hash);
    if (previous) return previous;
    const latest = await c.query(
      `SELECT v.sha256 FROM document_versions v JOIN documents d ON d.id=v.document_id
      WHERE d.carrier_id=$1 AND d.type=$2 AND d.${slotFilter(data.load_id)} ORDER BY v.version DESC LIMIT 1`,
      slotParams(data),
    );
    if (latest.rows[0]?.sha256 === sha256)
      throw new HttpError(409, "DUPLICATE_DOCUMENT_VERSION");
    return null;
  });
}

/** Scans when configured; infected files are logged and never stored. */
async function scanOrReject(
  user: string,
  data: Upload,
  bytes: Buffer,
  filename: string,
  sha256: string,
  onInfected?: (c: PoolClient) => Promise<void>,
) {
  const scanner = configuredScanner();
  if (!scanner) {
    if (scanRequired()) throw new HttpError(503, "SCAN_UNAVAILABLE");
    return null;
  }
  let scan: ScanResult;
  try {
    scan = await scanner.scan(bytes);
  } catch (e) {
    if (!(e instanceof ScannerUnavailable)) throw e;
    console.error("document.scan_unavailable", e.message);
    throw new HttpError(503, "SCAN_UNAVAILABLE");
  }
  if (scan.verdict === "infected") {
    await transaction(async (c) => {
      await c.query(
        "INSERT INTO document_scans(id,carrier_id,version_id,actor_id,sha256,filename,verdict,engine,signature) VALUES($1,$2,NULL,$3,$4,$5,'infected',$6,$7)",
        [
          randomUUID(),
          data.carrier_id,
          user,
          sha256,
          filename,
          scan.engine,
          scan.signature,
        ],
      );
      await emit(c, user, data.carrier_id, "document.malware_rejected", {
        type: data.type,
        load_id: data.load_id ?? null,
        sha256,
        signature: scan.signature,
      });
      if (onInfected) await onInfected(c);
    });
    throw new HttpError(422, "MALWARE_DETECTED");
  }
  return scan;
}

/** One transaction: object location, immutable version, scan row, events. */
async function recordVersion(
  user: string,
  data: Upload,
  hash: string,
  file: {
    filename: string;
    sha256: string;
    contentType: string;
    size: number;
    storageKey: string;
    object:
      | { backend: "s3"; bucket: string }
      | { backend: "postgres"; bytes: Buffer };
  },
  scan: ScanResult | null,
  onRecorded?: (c: PoolClient, versionId: string) => Promise<void>,
) {
  return transaction(async (c) => {
    const load = await authorizeUpload(c, user, data);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":document:" + data.idempotency_key,
    ]);
    const previous = await replay(c, user, data.idempotency_key, hash);
    if (previous) {
      if (onRecorded) await onRecorded(c, previous.version_id);
      return previous;
    }
    await c.query(
      data.load_id
        ? "INSERT INTO documents(id,carrier_id,load_id,type,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(load_id,type) WHERE load_id IS NOT NULL DO NOTHING"
        : "INSERT INTO documents(id,carrier_id,load_id,type,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(carrier_id,type) WHERE load_id IS NULL DO NOTHING",
      [randomUUID(), data.carrier_id, data.load_id ?? null, data.type, user],
    );
    // Lock the slot so concurrent uploads receive consecutive version numbers.
    const slot = await c.query(
      `SELECT id FROM documents WHERE carrier_id=$1 AND type=$2 AND ${slotFilter(data.load_id)} FOR UPDATE`,
      slotParams(data),
    );
    const documentId: string = slot.rows[0].id;
    const latest = await c.query(
      "SELECT version,sha256 FROM document_versions WHERE document_id=$1 ORDER BY version DESC LIMIT 1",
      [documentId],
    );
    if (latest.rows[0]?.sha256 === file.sha256)
      throw new HttpError(409, "DUPLICATE_DOCUMENT_VERSION");
    const version = (latest.rows[0]?.version ?? 0) + 1;
    const versionId = randomUUID();
    await c.query(
      "INSERT INTO document_objects(storage_key,content,backend,bucket) VALUES($1,$2,$3,$4)",
      file.object.backend === "s3"
        ? [file.storageKey, null, "s3", file.object.bucket]
        : [file.storageKey, file.object.bytes, "postgres", null],
    );
    await c.query(
      `INSERT INTO document_versions(id,document_id,carrier_id,version,filename,content_type,size_bytes,sha256,storage_key,expires_on,uploaded_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        versionId,
        documentId,
        data.carrier_id,
        version,
        file.filename,
        file.contentType,
        file.size,
        file.sha256,
        file.storageKey,
        data.expires_on ?? null,
        user,
        data.idempotency_key,
        hash,
      ],
    );
    if (scan)
      await c.query(
        "INSERT INTO document_scans(id,carrier_id,version_id,actor_id,sha256,filename,verdict,engine) VALUES($1,$2,$3,$4,$5,$6,'clean',$7)",
        [
          randomUUID(),
          data.carrier_id,
          versionId,
          user,
          file.sha256,
          file.filename,
          scan.engine,
        ],
      );
    if (onRecorded) await onRecorded(c, versionId);
    const payload = {
      document_id: documentId,
      version_id: versionId,
      type: data.type,
      version,
      filename: file.filename,
      sha256: file.sha256,
      scan: scan?.verdict ?? "not_scanned",
    };
    if (load) await event(c, user, load, "document.uploaded", payload);
    else await emit(c, user, data.carrier_id, "document.uploaded", payload);
    return { document_id: documentId, version_id: versionId, version };
  });
}
/** Final key, deterministic per request so an uncertain retry reuses it. */
const finalKey = (data: Upload, user: string) =>
  `documents/${data.carrier_id}/${user}/${data.idempotency_key}`;

/**
 * Upload through the app server, up to 4 MiB (ADR 0012): validate →
 * authorize and replay check → malware scan (fail closed when a scanner is
 * configured or required) → write bytes to object storage when configured →
 * record the version. Infected files are never stored.
 */
export async function uploadDocument(
  user: string,
  input: unknown,
  file: UploadFile | null,
) {
  const data = uploadSchema.parse(input);
  if (!file || file.bytes.length === 0)
    throw new HttpError(400, "FILE_REQUIRED");
  if (file.bytes.length > maxDocumentBytes)
    throw new HttpError(413, "FILE_TOO_LARGE");
  const contentType = sniffContentType(file.bytes);
  if (!contentType) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE");
  const filename = cleanFilename(file.name);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const hash = uploadHash(data, filename, sha256);
  // Nothing is scanned or written externally for callers without access.
  const early = await precheck(user, data, hash, sha256);
  if (early) return early;
  const scan = await scanOrReject(user, data, file.bytes, filename, sha256);
  const storageKey = finalKey(data, user);
  const bucket = objectStore();
  if (bucket)
    try {
      await bucket.put(storageKey, file.bytes, sha256);
    } catch (e) {
      if (!(e instanceof StorageUnavailable)) throw e;
      console.error("document.storage_unavailable", e.message);
      throw new HttpError(503, "STORAGE_UNAVAILABLE");
    }
  return recordVersion(
    user,
    data,
    hash,
    {
      filename,
      sha256,
      contentType,
      size: file.bytes.length,
      storageKey,
      object: bucket
        ? { backend: "s3", bucket: bucket.bucket }
        : { backend: "postgres", bytes: file.bytes },
    },
    scan,
  );
}

// ---------- Direct-to-bucket uploads (ADR 0015) ----------

export const sessionSchema = z
  .object({
    carrier_id: z.uuid(),
    load_id: z.uuid().optional(),
    type: z.enum(allTypes),
    expires_on: z.iso.date().optional(),
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
    filename: z.string().min(1).max(500),
    size_bytes: z.number().int().positive().max(maxDirectUploadBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const sessionWindowMinutes = 15;
const finalizeWindowMinutes = 60;

/**
 * Reserves a quarantine key for one declared file and returns a 15-minute
 * presigned PUT. The signature fixes the exact byte count; nothing is a
 * document until finalizeUpload has verified and scanned the bytes.
 */
export async function createUploadSession(user: string, input: unknown) {
  const raw = sessionSchema.parse(input);
  const { filename: rawName, size_bytes, sha256, ...rest } = raw;
  const data = uploadSchema.parse(rest);
  const filename = cleanFilename(rawName);
  const bucket = objectStore();
  if (!bucket) throw new HttpError(409, "DIRECT_UPLOAD_UNAVAILABLE");
  const hash = uploadHash(data, filename, sha256);
  const finished = await precheck(user, data, hash, sha256);
  if (finished) return { status: "finalized" as const, ...finished };
  const sessionHash = digest(JSON.stringify({ hash, size_bytes }));
  const session = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":upload-session:" + data.idempotency_key,
    ]);
    const old = await c.query(
      "SELECT * FROM document_upload_sessions WHERE actor_id=$1 AND idempotency_key=$2",
      [user, data.idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== sessionHash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      if (old.rows[0].status === "rejected")
        throw new HttpError(422, old.rows[0].failure);
      return old.rows[0];
    }
    const id = randomUUID();
    const { rows } = await c.query(
      `INSERT INTO document_upload_sessions(id,actor_id,carrier_id,load_id,type,expires_on,filename,size_bytes,sha256,bucket,quarantine_key,expires_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+($12*interval '1 minute'),$13,$14) RETURNING *`,
      [
        id,
        user,
        data.carrier_id,
        data.load_id ?? null,
        data.type,
        data.expires_on ?? null,
        filename,
        size_bytes,
        sha256,
        bucket.bucket,
        `quarantine/${data.carrier_id}/${id}`,
        sessionWindowMinutes,
        data.idempotency_key,
        sessionHash,
      ],
    );
    return rows[0];
  });
  if (session.status === "finalized") {
    const v = await transaction((c) =>
      replay(c, user, data.idempotency_key, hash),
    );
    return { status: "finalized" as const, ...v! };
  }
  return {
    status: "pending" as const,
    session_id: session.id as string,
    upload_url: bucket.presignUpload(
      session.quarantine_key,
      session.size_bytes,
      sessionWindowMinutes * 60,
    ),
    upload_headers: { "Content-Type": "application/octet-stream" },
    expires_at: session.expires_at,
  };
}

/**
 * Verifies a direct upload and turns it into a version: the bytes are read
 * back from quarantine, size, checksum and content type are checked, the
 * malware scan runs, and only a clean file is copied to its final key.
 * Safe to retry; a scanner or storage outage leaves the session pending.
 */
export async function finalizeUpload(user: string, sessionId: string) {
  const bucket = objectStore();
  if (!bucket) throw new HttpError(409, "DIRECT_UPLOAD_UNAVAILABLE");
  const { rows } = await transaction((c) =>
    c.query(
      "SELECT *,to_char(expires_on,'YYYY-MM-DD') expires_on_text,created_at<now()-($3*interval '1 minute') stale FROM document_upload_sessions WHERE id=$1 AND actor_id=$2",
      [sessionId, user, finalizeWindowMinutes],
    ),
  );
  const session = rows[0];
  if (!session) throw new HttpError(404, "NOT_FOUND");
  const data = uploadSchema.parse({
    carrier_id: session.carrier_id,
    type: session.type,
    idempotency_key: session.idempotency_key,
    ...(session.load_id ? { load_id: session.load_id } : {}),
    ...(session.expires_on_text ? { expires_on: session.expires_on_text } : {}),
  });
  const hash = uploadHash(data, session.filename, session.sha256);
  if (session.status === "rejected") throw new HttpError(422, session.failure);
  if (session.status === "finalized") {
    const v = await transaction((c) =>
      replay(c, user, data.idempotency_key, hash),
    );
    return v!;
  }
  if (session.stale) throw new HttpError(410, "UPLOAD_EXPIRED");
  const reject = async (code: string, c?: PoolClient) => {
    const sql =
      "UPDATE document_upload_sessions SET status='rejected',failure=$2 WHERE id=$1 AND status='pending'";
    if (c) await c.query(sql, [sessionId, code]);
    else await transaction((t) => t.query(sql, [sessionId, code]));
  };
  // Permissions may have changed since the session started.
  await transaction((c) => authorizeUpload(c, user, data));
  let bytes: Buffer;
  try {
    const head = await bucket.head(session.quarantine_key);
    if (!head) throw new HttpError(409, "UPLOAD_NOT_RECEIVED");
    if (head.size !== session.size_bytes) {
      await reject("UPLOAD_SIZE_MISMATCH");
      throw new HttpError(422, "UPLOAD_SIZE_MISMATCH");
    }
    bytes = await bucket.get(session.quarantine_key);
  } catch (e) {
    if (!(e instanceof StorageUnavailable)) throw e;
    throw new HttpError(503, "STORAGE_UNAVAILABLE");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== session.sha256) {
    await reject("UPLOAD_CHECKSUM_MISMATCH");
    throw new HttpError(422, "UPLOAD_CHECKSUM_MISMATCH");
  }
  const contentType = sniffContentType(bytes);
  if (!contentType) {
    await reject("UNSUPPORTED_FILE_TYPE");
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE");
  }
  const scan = await scanOrReject(
    user,
    data,
    bytes,
    session.filename,
    session.sha256,
    (c) => reject("MALWARE_DETECTED", c),
  );
  const storageKey = finalKey(data, user);
  try {
    await bucket.copy(session.quarantine_key, storageKey, session.sha256);
  } catch (e) {
    if (!(e instanceof StorageUnavailable)) throw e;
    console.error("document.storage_unavailable", e.message);
    throw new HttpError(503, "STORAGE_UNAVAILABLE");
  }
  return recordVersion(
    user,
    data,
    hash,
    {
      filename: session.filename,
      sha256: session.sha256,
      contentType,
      size: bytes.length,
      storageKey,
      object: { backend: "s3", bucket: bucket.bucket },
    },
    scan,
    async (c, versionId) => {
      await c.query(
        "UPDATE document_upload_sessions SET status='finalized',version_id=$2 WHERE id=$1 AND status='pending'",
        [sessionId, versionId],
      );
    },
  );
}

/** Locate a version and confirm the caller may read it. Foreign IDs are 404. */
async function readable(
  c: PoolClient,
  user: string,
  versionId: string,
  write = false,
) {
  const { rows } = await c.query(
    `SELECT v.*,d.type,d.load_id FROM document_versions v JOIN documents d ON d.id=v.document_id
     WHERE v.id=$1 AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=$2 AND m.carrier_id=v.carrier_id)`,
    [versionId, user],
  );
  const version = rows[0];
  if (!version) throw new HttpError(404, "NOT_FOUND");
  if (version.load_id) {
    const load = await scoped(c, user, version.load_id, write);
    return { version, load };
  }
  await member(c, user, version.carrier_id, true);
  return { version, load: null };
}

export type DocumentDownload =
  | { kind: "inline"; filename: string; content_type: string; content: Buffer }
  | { kind: "redirect"; url: string };

/** Authorizes and audits, then serves bytes or a 60-second signed URL. */
export async function documentContent(
  user: string,
  versionId: string,
): Promise<DocumentDownload> {
  return transaction(async (c) => {
    const { version } = await readable(c, user, versionId);
    const object = await c.query(
      "SELECT backend,bucket,content FROM document_objects WHERE storage_key=$1",
      [version.storage_key],
    );
    const row = object.rows[0];
    let result: DocumentDownload;
    if (row?.backend === "postgres" && row.content)
      result = {
        kind: "inline",
        filename: version.filename,
        content_type: version.content_type,
        content: row.content,
      };
    else {
      const bucket = objectStore();
      if (!row || !bucket || bucket.bucket !== row.bucket) {
        console.error("document.object_store_unconfigured", versionId);
        throw new HttpError(503, "DOCUMENT_UNAVAILABLE");
      }
      result = {
        kind: "redirect",
        url: bucket.presignDownload(
          version.storage_key,
          version.filename,
          version.content_type,
        ),
      };
    }
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "document.downloaded",
      versionId,
    ]);
    return result;
  });
}

export const reviewSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    note: z.string().trim().max(1000).default(""),
  })
  .strict()
  .refine((d) => d.decision === "accepted" || d.note.length > 0, {
    message: "Explain why the document was rejected",
    path: ["note"],
  });

/** Writes an append-only review. Callers must already hold dispatcher access. */
export async function insertReview(
  c: PoolClient,
  user: string,
  version: { id: string; carrier_id: string },
  decision: "accepted" | "rejected",
  note: string,
) {
  await c.query(
    "INSERT INTO document_reviews(id,version_id,carrier_id,reviewer_id,decision,note) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), version.id, version.carrier_id, user, decision, note],
  );
}

export async function reviewDocument(
  user: string,
  versionId: string,
  input: unknown,
) {
  const data = reviewSchema.parse(input);
  return transaction(async (c) => {
    const { version, load } = await readable(c, user, versionId, true);
    const membership = await member(c, user, version.carrier_id, true);
    if (membership.role !== "dispatcher")
      throw new HttpError(403, "DISPATCHER_REVIEW_REQUIRED");
    const latest = await c.query(
      "SELECT id FROM document_versions WHERE document_id=$1 ORDER BY version DESC LIMIT 1 FOR SHARE",
      [version.document_id],
    );
    if (latest.rows[0].id !== versionId)
      throw new HttpError(409, "DOCUMENT_SUPERSEDED");
    await insertReview(c, user, version, data.decision, data.note);
    const payload = {
      document_id: version.document_id,
      version_id: versionId,
      type: version.type,
      decision: data.decision,
    };
    if (load) await event(c, user, load, "document.reviewed", payload);
    else await emit(c, user, version.carrier_id, "document.reviewed", payload);
    return { version_id: versionId, decision: data.decision };
  });
}

export async function carrierDocuments(user: string, carrierId: string) {
  return transaction(async (c) => {
    const membership = await member(c, user, carrierId, true);
    const agreement = await c.query(
      `SELECT a.agreement_ref,a.effective_at,a.expires_at,a.verified_at,a.document_version_id,
        (a.verified_at<=now() AND a.effective_at<=now() AND a.expires_at>now()) current
      FROM carrier_dispatch_authorizations a WHERE a.carrier_id=$1
      ORDER BY (a.verified_at<=now() AND a.effective_at<=now() AND a.expires_at>now()) DESC,a.expires_at DESC LIMIT 1`,
      [carrierId],
    );
    return {
      carrier_id: carrierId,
      can_review: membership.role === "dispatcher",
      agreement: agreement.rows[0] ?? null,
      slots: await carrierDocumentSlots(c, carrierId),
    };
  });
}
