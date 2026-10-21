import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { event, member, scoped } from "./loads";
import { emit } from "./onboarding";
import { postgresStore as store } from "./storage";
import {
  carrierDocumentTypes,
  cleanFilename,
  documentStatus,
  driverUploadTypes,
  expiringTypes,
  loadDocumentTypes,
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
        WHERE r.version_id=v.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) review
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
  const { idempotency_key, ...metadata } = data;
  const hash = digest(JSON.stringify({ ...metadata, filename, sha256 }));
  return transaction(async (c) => {
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
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":document:" + idempotency_key,
    ]);
    const old = await c.query(
      "SELECT id,document_id,version,request_hash FROM document_versions WHERE uploaded_by=$1 AND idempotency_key=$2",
      [user, idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return {
        document_id: old.rows[0].document_id,
        version_id: old.rows[0].id,
        version: old.rows[0].version,
      };
    }
    await c.query(
      data.load_id
        ? "INSERT INTO documents(id,carrier_id,load_id,type,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(load_id,type) WHERE load_id IS NOT NULL DO NOTHING"
        : "INSERT INTO documents(id,carrier_id,load_id,type,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(carrier_id,type) WHERE load_id IS NULL DO NOTHING",
      [randomUUID(), data.carrier_id, data.load_id ?? null, data.type, user],
    );
    // Lock the slot so concurrent uploads receive consecutive version numbers.
    const slot = await c.query(
      `SELECT id FROM documents WHERE carrier_id=$1 AND type=$2 AND ${data.load_id ? "load_id=$3" : "load_id IS NULL"} FOR UPDATE`,
      data.load_id
        ? [data.carrier_id, data.type, data.load_id]
        : [data.carrier_id, data.type],
    );
    const documentId: string = slot.rows[0].id;
    const latest = await c.query(
      "SELECT version,sha256 FROM document_versions WHERE document_id=$1 ORDER BY version DESC LIMIT 1",
      [documentId],
    );
    if (latest.rows[0]?.sha256 === sha256)
      throw new HttpError(409, "DUPLICATE_DOCUMENT_VERSION");
    const version = (latest.rows[0]?.version ?? 0) + 1;
    const versionId = randomUUID();
    const storageKey = `documents/${data.carrier_id}/${documentId}/${versionId}`;
    await store.put(c, storageKey, file.bytes);
    await c.query(
      `INSERT INTO document_versions(id,document_id,carrier_id,version,filename,content_type,size_bytes,sha256,storage_key,expires_on,uploaded_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        versionId,
        documentId,
        data.carrier_id,
        version,
        filename,
        contentType,
        file.bytes.length,
        sha256,
        storageKey,
        data.expires_on ?? null,
        user,
        idempotency_key,
        hash,
      ],
    );
    const payload = {
      document_id: documentId,
      version_id: versionId,
      type: data.type,
      version,
      filename,
      sha256,
    };
    if (load) await event(c, user, load, "document.uploaded", payload);
    else await emit(c, user, data.carrier_id, "document.uploaded", payload);
    return { document_id: documentId, version_id: versionId, version };
  });
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

export async function documentContent(user: string, versionId: string) {
  return transaction(async (c) => {
    const { version } = await readable(c, user, versionId);
    const content = await store.get(c, version.storage_key);
    if (!content) throw new HttpError(503, "DOCUMENT_UNAVAILABLE");
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "document.downloaded",
      versionId,
    ]);
    return {
      filename: version.filename as string,
      content_type: version.content_type as string,
      content,
    };
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
