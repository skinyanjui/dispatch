import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { member, requireAgreement } from "./loads";
import { scanBeforeReading } from "./documents";
import {
  costMicros,
  extractionProvider,
  ProviderError,
  reserveMicros,
} from "./ai";
import { spentMicros } from "./extractions";
import {
  cleanFilename,
  maxDocumentBytes,
  sniffContentType,
} from "./compliance";
import {
  draftType,
  promptVersion,
  resultSchema,
  type Suggestions,
} from "./extraction";
import { rateDraft, type RateDraft } from "./rate-draft";

// Rate confirmation to draft load (ADR 0032). A person uploads the broker's
// rate confirmation, the model suggests the load's values, and the Create
// load form opens pre-filled for that person to review and submit. Nothing
// here creates or changes a load; booking authority stays with the normal
// create path and its verified-dispatch-agreement check.

const MICROS_PER_CENT = 10_000;
const staleMinutes = 5;

export type RateRead = {
  id: string;
  status: "running" | "succeeded" | "failed";
  error_code: string | null;
  filename: string;
  provider: string;
  model: string;
  /** Present when the reading succeeded. */
  draft: RateDraft | null;
};

const readSchema = z
  .object({
    carrier_id: z.uuid(),
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
  })
  .strict();

async function carrierOrg(c: PoolClient, carrierId: string) {
  const { rows } = await c.query(
    "SELECT organization_id FROM carriers WHERE id=$1",
    [carrierId],
  );
  return rows[0]?.organization_id as string;
}

/** What the page needs to show the right control before anything is sent. */
export async function rateReadStatus(user: string, carrierId: string) {
  const id = z.uuid().parse(carrierId);
  return transaction(async (c) => {
    // Same people who can create a load for this carrier.
    await member(c, user, id, true);
    const org = await carrierOrg(c, id);
    const [settings, admin] = await Promise.all([
      c.query(
        "SELECT extraction_enabled FROM organization_ai_settings WHERE organization_id=$1",
        [org],
      ),
      c.query(
        "SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2",
        [org, user],
      ),
    ]);
    return {
      available: extractionProvider() !== null,
      enabled: settings.rows[0]?.extraction_enabled ?? false,
      can_enable: (admin.rowCount ?? 0) > 0,
      organization_id: org,
      provider: extractionProvider()?.name ?? null,
    };
  });
}

async function view(
  db: PoolClient | typeof pool,
  id: string,
): Promise<RateRead> {
  const { rows } = await db.query(
    "SELECT id,status,error_code,filename,provider,model,fields FROM rate_confirmation_reads WHERE id=$1",
    [id],
  );
  const r = rows[0];
  return {
    id: r.id,
    status: r.status,
    error_code: r.error_code,
    filename: r.filename,
    provider: r.provider,
    model: r.model,
    draft:
      r.status === "succeeded" && r.fields
        ? rateDraft(r.fields as Suggestions)
        : null,
  };
}

export async function readRateConfirmation(
  user: string,
  input: unknown,
  file: { name: string; bytes: Buffer } | null,
): Promise<RateRead> {
  const data = readSchema.parse(input);
  if (!file || file.bytes.length === 0)
    throw new HttpError(400, "FILE_REQUIRED");
  if (file.bytes.length > maxDocumentBytes)
    throw new HttpError(413, "FILE_TOO_LARGE");
  const contentType = sniffContentType(file.bytes) as
    | "application/pdf"
    | "image/png"
    | "image/jpeg"
    | null;
  if (!contentType) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE");
  const filename = cleanFilename(file.name);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const hash = digest(
    JSON.stringify({
      carrier_id: data.carrier_id,
      sha256,
      promptVersion,
      type: draftType,
    }),
  );

  const started = await transaction(async (c) => {
    await member(c, user, data.carrier_id, true);
    const replay = await c.query(
      "SELECT id,request_hash FROM rate_confirmation_reads WHERE requested_by=$1 AND idempotency_key=$2",
      [user, data.idempotency_key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { done: await view(c, replay.rows[0].id) };
    }
    // Reading is only useful if the load could be created afterwards.
    await requireAgreement(c, data.carrier_id);
    const org = await carrierOrg(c, data.carrier_id);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "ai:" + org,
    ]);
    const settings = await c.query(
      "SELECT extraction_enabled,monthly_limit_cents FROM organization_ai_settings WHERE organization_id=$1",
      [org],
    );
    if (!settings.rows[0]?.extraction_enabled)
      throw new HttpError(403, "AI_NOT_ENABLED");
    const provider = extractionProvider();
    if (!provider) throw new HttpError(503, "AI_UNAVAILABLE");
    // A reading that died with its server stops holding the budget.
    await c.query(
      `UPDATE rate_confirmation_reads SET status='failed',error_code='TIMED_OUT',cost_micros=0,completed_at=now()
      WHERE requested_by=$1 AND status='running' AND created_at<now()-make_interval(mins=>$2)`,
      [user, staleMinutes],
    );
    const running = await c.query(
      "SELECT 1 FROM rate_confirmation_reads WHERE requested_by=$1 AND status='running'",
      [user],
    );
    if (running.rowCount) throw new HttpError(409, "ALREADY_RUNNING");
    const reserve = reserveMicros(provider.model, file.bytes.length);
    if (
      (await spentMicros(c, org)) + reserve >
      settings.rows[0].monthly_limit_cents * MICROS_PER_CENT
    )
      throw new HttpError(402, "AI_BUDGET_REACHED");
    const id = randomUUID();
    await c.query(
      `INSERT INTO rate_confirmation_reads(id,organization_id,carrier_id,requested_by,filename,sha256,size_bytes,status,
        provider,model,prompt_version,reserved_micros,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11,$12,$13)`,
      [
        id,
        org,
        data.carrier_id,
        user,
        filename,
        sha256,
        file.bytes.length,
        provider.name,
        provider.model,
        promptVersion,
        reserve,
        data.idempotency_key,
        hash,
      ],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'ai.rate_read.requested',$3,now())",
      [randomUUID(), user, id],
    );
    return { id, provider, reserve };
  });
  if ("done" in started && started.done) return started.done;
  const run = started as {
    id: string;
    provider: NonNullable<ReturnType<typeof extractionProvider>>;
    reserve: number;
  };

  const finish = (code: string, charge: boolean) =>
    transaction(async (c) => {
      await c.query(
        "UPDATE rate_confirmation_reads SET status='failed',error_code=$2,cost_micros=$3,completed_at=now() WHERE id=$1",
        [run.id, code, charge ? run.reserve : 0],
      );
      await c.query(
        "INSERT INTO audit_logs VALUES($1,$2,'ai.rate_read.failed',$3,now())",
        [randomUUID(), user, run.id],
      );
    });
  // Malware scan first: nothing infected is ever sent to the model.
  try {
    await scanBeforeReading(
      user,
      data.carrier_id,
      file.bytes,
      filename,
      sha256,
    );
  } catch (e) {
    await finish(e instanceof HttpError ? e.code : "SCAN_UNAVAILABLE", false);
    throw e;
  }
  let outcome:
    | {
        ok: true;
        fields: Suggestions;
        model: string;
        inputTokens: number;
        outputTokens: number;
      }
    | { ok: false; code: string; charge: boolean };
  try {
    const result = await run.provider.read({
      type: draftType,
      filename,
      contentType,
      bytes: file.bytes,
    });
    const parsed = resultSchema(draftType).safeParse(result.fields);
    outcome = parsed.success
      ? {
          ok: true,
          fields: parsed.data as Suggestions,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        }
      : { ok: false, code: "PROVIDER_INVALID_OUTPUT", charge: true };
  } catch (error) {
    const code =
      error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    outcome = {
      ok: false,
      code,
      charge: code === "PROVIDER_REFUSED" || code === "PROVIDER_INVALID_OUTPUT",
    };
  }
  if (!outcome.ok) await finish(outcome.code, outcome.charge);
  else
    await transaction(async (c) => {
      await c.query(
        `UPDATE rate_confirmation_reads SET status='succeeded',fields=$2,model=$3,input_tokens=$4,output_tokens=$5,
        cost_micros=$6,completed_at=now() WHERE id=$1`,
        [
          run.id,
          JSON.stringify(outcome.fields),
          outcome.model,
          outcome.inputTokens,
          outcome.outputTokens,
          costMicros(outcome.model, outcome.inputTokens, outcome.outputTokens),
        ],
      );
      await c.query(
        "INSERT INTO audit_logs VALUES($1,$2,'ai.rate_read.completed',$3,now())",
        [randomUUID(), user, run.id],
      );
    });
  return view(pool, run.id);
}
