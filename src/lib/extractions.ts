import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, HttpError } from "./auth";
import { member } from "./loads";
import { orgAdmin } from "./account";
import { readable } from "./documents";
import { assistantProvider } from "./assistant-ai";
import { objectStore, readPostgresObject } from "./storage";
import {
  costMicros,
  extractionProvider,
  ProviderError,
  reserveMicros,
} from "./ai";
import {
  isExtractable,
  promptVersion,
  type ExtractableType,
  type ExtractionView,
} from "./extraction";

// Document reading (ADR 0028). Every request is consented, budgeted, audited
// and idempotent; the result is advice stored next to the file, never applied.

const MICROS_PER_CENT = 10_000;
const maxFailedAttempts = 3;
/** A request left "running" longer than this died with its server. */
const staleMinutes = 5;

export const aiSettingsSchema = z
  .object({
    version: z.number().int().nonnegative(),
    enabled: z.boolean(),
    /** Omitted keeps the current choice. */
    assistant_enabled: z.boolean().optional(),
    monthly_limit_cents: z.number().int().min(0).max(1_000_000),
  })
  .strict();

export async function spentMicros(c: PoolClient, organizationId: string) {
  const { rows } = await c.query(
    `SELECT COALESCE(sum(COALESCE(cost_micros,reserved_micros)),0)::bigint spent
    FROM document_extractions WHERE organization_id=$1
      AND created_at>=date_trunc('month',now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`,
    [organizationId],
  );
  // The assistant shares the same monthly limit (ADR 0031).
  const chat = await c.query(
    `SELECT COALESCE(sum(COALESCE(cost_micros,reserved_micros)),0)::bigint spent
    FROM assistant_turns WHERE organization_id=$1
      AND created_at>=date_trunc('month',now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`,
    [organizationId],
  );
  const reads = await c.query(
    `SELECT COALESCE(sum(COALESCE(cost_micros,reserved_micros)),0)::bigint spent
    FROM rate_confirmation_reads WHERE organization_id=$1
      AND created_at>=date_trunc('month',now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`,
    [organizationId],
  );
  return (
    Number(rows[0].spent) +
    Number(chat.rows[0].spent) +
    Number(reads.rows[0].spent)
  );
}

/** What the organization settings screen shows. */
export async function aiStatus(user: string, organizationId: string) {
  return transaction(async (c) => {
    await orgAdmin(c, user, organizationId);
    const provider = extractionProvider();
    const settings = await c.query(
      "SELECT extraction_enabled,assistant_enabled,monthly_limit_cents,version FROM organization_ai_settings WHERE organization_id=$1",
      [organizationId],
    );
    const row = settings.rows[0];
    return {
      available: provider !== null,
      provider: provider
        ? { name: provider.name, model: provider.model }
        : null,
      enabled: row?.extraction_enabled ?? false,
      assistant_enabled: row?.assistant_enabled ?? false,
      monthly_limit_cents: row?.monthly_limit_cents ?? 1000,
      spent_cents: Math.ceil(
        (await spentMicros(c, organizationId)) / MICROS_PER_CENT,
      ),
      version: row?.version ?? 0,
    };
  });
}

/** Owners and admins turn document reading on or off and set the monthly cap. */
export async function saveAiSettings(
  user: string,
  organizationId: string,
  input: unknown,
) {
  const data = aiSettingsSchema.parse(input);
  return transaction(async (c) => {
    await orgAdmin(c, user, organizationId);
    await c.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [
      organizationId,
    ]);
    const current = await c.query(
      "SELECT version,assistant_enabled FROM organization_ai_settings WHERE organization_id=$1",
      [organizationId],
    );
    if ((current.rows[0]?.version ?? 0) !== data.version)
      throw new HttpError(409, "VERSION_CONFLICT");
    const assistant =
      data.assistant_enabled ?? current.rows[0]?.assistant_enabled ?? false;
    if (
      (data.enabled && !extractionProvider()) ||
      (assistant && !assistantProvider())
    )
      throw new HttpError(503, "AI_UNAVAILABLE");
    await c.query(
      `INSERT INTO organization_ai_settings(organization_id,extraction_enabled,assistant_enabled,monthly_limit_cents,enabled_by)
      VALUES($1,$2,$5,$3,$4) ON CONFLICT(organization_id) DO UPDATE SET extraction_enabled=$2,assistant_enabled=$5,
      monthly_limit_cents=$3,enabled_by=$4,version=organization_ai_settings.version+1,updated_at=now()`,
      [organizationId, data.enabled, data.monthly_limit_cents, user, assistant],
    );
    if (assistant !== (current.rows[0]?.assistant_enabled ?? false))
      await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
        randomUUID(),
        user,
        assistant ? "ai.assistant.enabled" : "ai.assistant.disabled",
        organizationId,
      ]);
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      data.enabled ? "ai.extraction.enabled" : "ai.extraction.disabled",
      organizationId,
    ]);
    return { id: organizationId, version: data.version + 1 };
  });
}

async function fileBytes(
  c: PoolClient,
  version: { storage_key: string; sha256: string },
) {
  const object = await c.query(
    "SELECT backend,bucket FROM document_objects WHERE storage_key=$1",
    [version.storage_key],
  );
  const row = object.rows[0];
  let bytes: Buffer | null = null;
  if (row?.backend === "postgres")
    bytes = await readPostgresObject(c, version.storage_key);
  else if (row) {
    const store = objectStore();
    if (store && store.bucket === row.bucket)
      bytes = await store.get(version.storage_key);
  }
  if (!bytes) throw new HttpError(503, "DOCUMENT_UNAVAILABLE");
  // The stored checksum guards against reading something other than the file
  // the version record describes.
  if (createHash("sha256").update(bytes).digest("hex") !== version.sha256)
    throw new HttpError(503, "DOCUMENT_UNAVAILABLE");
  return bytes;
}

const viewSql = `x.id,x.status,x.provider,x.model,x.prompt_version,x.fields,x.error_code,x.created_at,
  x.checked_at,cu.name checked_by_name,x.checked_fields`;
async function view(c: PoolClient, id: string): Promise<ExtractionView> {
  const { rows } = await c.query(
    `SELECT ${viewSql} FROM document_extractions x LEFT JOIN users cu ON cu.id=x.checked_by WHERE x.id=$1`,
    [id],
  );
  return rows[0];
}

/**
 * Asks the configured model to read one document version. Requires the
 * organization's consent and budget; returns the stored result for a repeated
 * key, and never changes the document, the load or any billing record.
 */
export async function requestExtraction(
  user: string,
  versionId: string,
  key: string | undefined,
): Promise<ExtractionView> {
  if (!key || key.length > 128)
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
  const hash = digest(JSON.stringify({ versionId, promptVersion }));
  const started = await transaction(async (c) => {
    const { version } = await readable(c, user, versionId, true);
    if (!isExtractable(version.type)) throw new HttpError(422, "NOT_READABLE");
    const replay = await c.query(
      "SELECT id,request_hash FROM document_extractions WHERE requested_by=$1 AND idempotency_key=$2",
      [user, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { done: await view(c, replay.rows[0].id) };
    }
    const carrier = await c.query(
      "SELECT organization_id FROM carriers WHERE id=$1",
      [version.carrier_id],
    );
    const organizationId = carrier.rows[0].organization_id as string;
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "ai:" + organizationId,
    ]);
    const settings = await c.query(
      "SELECT extraction_enabled,monthly_limit_cents FROM organization_ai_settings WHERE organization_id=$1",
      [organizationId],
    );
    if (!settings.rows[0]?.extraction_enabled)
      throw new HttpError(403, "AI_NOT_ENABLED");
    const provider = extractionProvider();
    if (!provider) throw new HttpError(503, "AI_UNAVAILABLE");
    const latest = await c.query(
      "SELECT id FROM document_versions WHERE document_id=$1 ORDER BY version DESC LIMIT 1",
      [version.document_id],
    );
    if (latest.rows[0].id !== versionId)
      throw new HttpError(409, "DOCUMENT_SUPERSEDED");
    // A request that died with its server stops holding the budget.
    await c.query(
      `UPDATE document_extractions SET status='failed',error_code='TIMED_OUT',cost_micros=0,completed_at=now()
      WHERE version_id=$1 AND status='running' AND created_at<now()-make_interval(mins=>$2)`,
      [versionId, staleMinutes],
    );
    const existing = await c.query(
      "SELECT id,status FROM document_extractions WHERE version_id=$1 AND status<>'dismissed' AND status<>'failed' ORDER BY created_at DESC LIMIT 1",
      [versionId],
    );
    if (existing.rows[0]?.status === "running")
      throw new HttpError(409, "ALREADY_RUNNING");
    // A good reading is kept; asking again costs money and changes nothing.
    if (existing.rows[0]) return { done: await view(c, existing.rows[0].id) };
    const failed = await c.query(
      "SELECT count(*)::int n FROM document_extractions WHERE version_id=$1 AND status='failed'",
      [versionId],
    );
    if (failed.rows[0].n >= maxFailedAttempts)
      throw new HttpError(429, "TOO_MANY_ATTEMPTS");
    const reserve = reserveMicros(provider.model, version.size_bytes);
    const limit = settings.rows[0].monthly_limit_cents * MICROS_PER_CENT;
    if ((await spentMicros(c, organizationId)) + reserve > limit)
      throw new HttpError(402, "AI_BUDGET_REACHED");
    const bytes = await fileBytes(c, version);
    const id = randomUUID();
    await c.query(
      `INSERT INTO document_extractions(id,version_id,carrier_id,organization_id,doc_type,status,provider,model,
        prompt_version,reserved_micros,requested_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        versionId,
        version.carrier_id,
        organizationId,
        version.type,
        provider.name,
        provider.model,
        promptVersion,
        reserve,
        user,
        key,
        hash,
      ],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "ai.extraction.requested",
      id,
    ]);
    return {
      id,
      provider,
      reserve,
      bytes,
      type: version.type as ExtractableType,
      filename: version.filename as string,
      contentType: version.content_type as
        | "application/pdf"
        | "image/png"
        | "image/jpeg",
    };
  });
  if (started.done) return started.done;

  // The model call runs outside any database transaction.
  let outcome:
    | { ok: true; result: Awaited<ReturnType<typeof started.provider.read>> }
    | { ok: false; code: string; charge: boolean };
  try {
    outcome = {
      ok: true,
      result: await started.provider.read({
        type: started.type,
        filename: started.filename,
        contentType: started.contentType,
        bytes: started.bytes,
      }),
    };
  } catch (error) {
    const code =
      error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    // A refusal or unusable answer may still have been billed, so it keeps its
    // reservation; an outage or a rejected file did not run.
    outcome = {
      ok: false,
      code,
      charge: code === "PROVIDER_REFUSED" || code === "PROVIDER_INVALID_OUTPUT",
    };
  }
  return transaction(async (c) => {
    if (outcome.ok) {
      const cost = costMicros(
        outcome.result.model,
        outcome.result.inputTokens,
        outcome.result.outputTokens,
      );
      await c.query(
        `UPDATE document_extractions SET status='succeeded',fields=$2,model=$3,input_tokens=$4,
        output_tokens=$5,cost_micros=$6,completed_at=now() WHERE id=$1`,
        [
          started.id,
          JSON.stringify(outcome.result.fields),
          outcome.result.model,
          outcome.result.inputTokens,
          outcome.result.outputTokens,
          cost,
        ],
      );
    } else {
      await c.query(
        `UPDATE document_extractions SET status='failed',error_code=$2,cost_micros=$3,completed_at=now() WHERE id=$1`,
        [started.id, outcome.code, outcome.charge ? started.reserve : 0],
      );
    }
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      outcome.ok ? "ai.extraction.completed" : "ai.extraction.failed",
      started.id,
    ]);
    return view(c, started.id);
  });
}

async function writable(c: PoolClient, user: string, id: string) {
  const { rows } = await c.query(
    `SELECT x.id,x.version_id,x.status,x.carrier_id FROM document_extractions x
    WHERE x.id=$1 AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=$2 AND m.carrier_id=x.carrier_id) FOR UPDATE OF x`,
    [id, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  await readable(c, user, rows[0].version_id, true);
  await member(c, user, rows[0].carrier_id, true);
  return rows[0];
}

export const checkSchema = z
  .object({
    /** Values the person confirmed or corrected, by field name. */
    fields: z
      .record(
        z.string().max(60),
        z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
      )
      .default({}),
  })
  .strict();

/** A person records that they compared the suggestions with the file. */
export async function checkExtraction(
  user: string,
  id: string,
  input: unknown,
) {
  const data = checkSchema.parse(input);
  return transaction(async (c) => {
    const row = await writable(c, user, id);
    if (row.status !== "succeeded") throw new HttpError(409, "NOT_READY");
    await c.query(
      "UPDATE document_extractions SET checked_by=$2,checked_at=now(),checked_fields=$3 WHERE id=$1 AND checked_at IS NULL",
      [id, user, JSON.stringify(data.fields)],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "ai.extraction.checked",
      id,
    ]);
    return view(c, id);
  });
}

/** Hides a result (for example a wrong reading) so it can be read again. */
export async function dismissExtraction(user: string, id: string) {
  return transaction(async (c) => {
    const row = await writable(c, user, id);
    if (row.status === "running") throw new HttpError(409, "ALREADY_RUNNING");
    await c.query(
      "UPDATE document_extractions SET status='dismissed' WHERE id=$1",
      [id],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      "ai.extraction.dismissed",
      id,
    ]);
    return { id, status: "dismissed" as const };
  });
}
