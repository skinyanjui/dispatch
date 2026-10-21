import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { access } from "./contacts";
import { spentMicros } from "./extractions";
import { costMicros, ProviderError } from "./ai";
import {
  assistantPromptVersion,
  assistantProvider,
  maxOutputTokens,
  reserveInputTokens,
  type ChatMessage,
} from "./assistant-ai";
import { runTool, ToolError } from "./assistant-tools";
import type {
  AssistantState,
  AssistantTurn,
  Conversation,
  Source,
} from "./assistant-types";

// The dispatch assistant (ADR 0031). Every question is consented, budgeted,
// audited and idempotent. The model reads through the person's own access and
// can change nothing; the sources shown are the records the tools returned.

const MICROS_PER_CENT = 10_000;
const staleMinutes = 3;
/** Keeps the whole turn inside the route's 60 second limit. */
const turnMs = 50_000;
const resultChars = 12_000;
const historyTurns = 6;

async function orgFor(
  c: PoolClient | typeof pool,
  user: string,
  wanted?: string,
) {
  const orgs = (await access(c, user)).organizations;
  if (wanted) {
    if (!orgs.includes(wanted)) throw new HttpError(404, "NOT_FOUND");
    return wanted;
  }
  // Without a choice, the organization they administer comes first, so the
  // person who can turn the assistant on sees the same organization.
  const admin = await c.query(
    "SELECT organization_id FROM organization_members WHERE user_id=$1 ORDER BY created_at,organization_id LIMIT 1",
    [user],
  );
  const org =
    (admin.rows[0]?.organization_id as string | undefined) ??
    [...orgs].sort()[0];
  if (!org || !orgs.includes(org)) throw new HttpError(404, "NOT_FOUND");
  return org;
}

const view = (r: Record<string, unknown>): AssistantTurn => {
  const tools = (r.tools ?? {}) as { sources?: Source[] };
  return {
    id: r.id as string,
    question: r.question as string,
    answer: (r.answer as string | null) ?? null,
    status: r.status as AssistantTurn["status"],
    error_code: (r.error_code as string | null) ?? null,
    sources: tools.sources ?? [],
    provider: r.provider as string,
    model: r.model as string,
    created_at: (r.created_at as Date).toISOString(),
  };
};

export async function assistantState(
  user: string,
  organizationId?: string,
): Promise<AssistantState> {
  const org = await orgFor(pool, user, organizationId);
  const provider = assistantProvider();
  const [settings, conversations] = await Promise.all([
    pool.query(
      "SELECT assistant_enabled FROM organization_ai_settings WHERE organization_id=$1",
      [org],
    ),
    pool.query(
      `SELECT id,title,updated_at FROM assistant_conversations
      WHERE user_id=$1 AND organization_id=$2 ORDER BY updated_at DESC,id LIMIT 30`,
      [user, org],
    ),
  ]);
  return {
    available: provider !== null,
    enabled: settings.rows[0]?.assistant_enabled ?? false,
    organization_id: org,
    provider: provider ? { name: provider.name, model: provider.model } : null,
    conversations: conversations.rows.map((r) => ({
      id: r.id,
      title: r.title,
      updated_at: r.updated_at.toISOString(),
    })),
  };
}

/** One conversation, only for the person who had it. */
export async function getConversation(
  user: string,
  id: string,
): Promise<Conversation> {
  const { rows } = await pool.query(
    "SELECT id,title FROM assistant_conversations WHERE id=$1 AND user_id=$2",
    [id, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  const turns = await pool.query(
    `SELECT id,question,answer,status,error_code,tools,provider,model,created_at
    FROM assistant_turns WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 200`,
    [id],
  );
  return { id, title: rows[0].title, turns: turns.rows.map(view) };
}

async function spent(c: PoolClient, org: string) {
  // One shared monthly limit across document reading, rate confirmation
  // reading and the assistant.
  return spentMicros(c, org);
}

export const askSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    conversation_id: z.uuid().optional(),
    organization_id: z.uuid().optional(),
  })
  .strict();

export async function ask(
  user: string,
  input: unknown,
  key: string | undefined,
) {
  if (!key || !z.uuid().safeParse(key).success)
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
  const data = askSchema.parse(input);
  const hash = digest(
    JSON.stringify({ ...data, promptVersion: assistantPromptVersion }),
  );
  const started = await transaction(async (c) => {
    const replay = await c.query(
      "SELECT id,request_hash,conversation_id FROM assistant_turns WHERE user_id=$1 AND idempotency_key=$2",
      [user, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { kind: "done" as const, id: replay.rows[0].id as string };
    }
    const org = await orgFor(c, user, data.organization_id);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "ai:" + org,
    ]);
    const settings = await c.query(
      "SELECT assistant_enabled,monthly_limit_cents FROM organization_ai_settings WHERE organization_id=$1",
      [org],
    );
    if (!settings.rows[0]?.assistant_enabled)
      throw new HttpError(403, "ASSISTANT_NOT_ENABLED");
    const provider = assistantProvider();
    if (!provider) throw new HttpError(503, "AI_UNAVAILABLE");
    // A turn that died with its server stops holding the budget.
    await c.query(
      `UPDATE assistant_turns SET status='failed',error_code='TIMED_OUT',cost_micros=0,completed_at=now()
      WHERE user_id=$1 AND status='running' AND created_at<now()-make_interval(mins=>$2)`,
      [user, staleMinutes],
    );
    const running = await c.query(
      "SELECT 1 FROM assistant_turns WHERE user_id=$1 AND status='running'",
      [user],
    );
    if (running.rowCount) throw new HttpError(409, "ALREADY_RUNNING");
    const reserve = costMicros(
      provider.model,
      reserveInputTokens,
      maxOutputTokens,
    );
    const limit = settings.rows[0].monthly_limit_cents * MICROS_PER_CENT;
    if ((await spent(c, org)) + reserve > limit)
      throw new HttpError(402, "AI_BUDGET_REACHED");
    let conversation = data.conversation_id;
    let history: ChatMessage[] = [];
    if (conversation) {
      const own = await c.query(
        "SELECT 1 FROM assistant_conversations WHERE id=$1 AND user_id=$2 AND organization_id=$3 FOR UPDATE",
        [conversation, user, org],
      );
      if (!own.rowCount) throw new HttpError(404, "NOT_FOUND");
      const past = await c.query(
        `SELECT question,answer FROM assistant_turns WHERE conversation_id=$1 AND status='succeeded'
        ORDER BY created_at DESC LIMIT $2`,
        [conversation, historyTurns],
      );
      history = past.rows.reverse().flatMap((r) => [
        { role: "user" as const, content: r.question as string },
        { role: "assistant" as const, content: r.answer as string },
      ]);
    } else {
      conversation = randomUUID();
      await c.query(
        "INSERT INTO assistant_conversations(id,organization_id,user_id,title) VALUES($1,$2,$3,$4)",
        [conversation, org, user, data.question.slice(0, 80)],
      );
    }
    const id = randomUUID();
    await c.query(
      `INSERT INTO assistant_turns(id,conversation_id,organization_id,user_id,question,status,provider,model,
        prompt_version,reserved_micros,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11)`,
      [
        id,
        conversation,
        org,
        user,
        data.question,
        provider.name,
        provider.model,
        assistantPromptVersion,
        reserve,
        key,
        hash,
      ],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'ai.assistant.asked',$3,now())",
      [randomUUID(), user, id],
    );
    return {
      kind: "run" as const,
      id,
      org,
      provider,
      reserve,
      history,
      conversation: conversation as string,
    };
  });
  if (started.kind === "done") return turnView(started.id, user);

  // The model call runs outside any database transaction.
  const sources = new Map<string, Source>();
  const calls: { name: string; input: unknown }[] = [];
  const callTool = async (name: string, toolInput: unknown) => {
    if (calls.length >= 12)
      return JSON.stringify({ error: "Too many lookups for one question." });
    calls.push({ name, input: toolInput });
    try {
      const result = await runTool(user, started.org, name, toolInput);
      for (const s of result.sources)
        if (sources.size < 40) sources.set(`${s.kind}:${s.id}`, s);
      const text = JSON.stringify(result.data);
      return text.length > resultChars
        ? text.slice(0, resultChars) + "…(truncated)"
        : text;
    } catch (e) {
      // The model reads this and can recover; nothing is thrown past the loop.
      const message =
        e instanceof ToolError
          ? e.message
          : e instanceof HttpError
            ? "Not available to this person."
            : e instanceof z.ZodError
              ? "Invalid input for this tool."
              : "That lookup failed.";
      return JSON.stringify({ error: message });
    }
  };
  let outcome:
    | {
        ok: true;
        answer: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
      }
    | { ok: false; code: string; charge: boolean };
  try {
    outcome = {
      ok: true,
      ...(await started.provider.run({
        history: started.history,
        question: data.question,
        callTool,
        deadline: Date.now() + turnMs,
      })),
    };
  } catch (error) {
    const code =
      error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    outcome = {
      ok: false,
      code,
      charge: code === "PROVIDER_REFUSED" || code === "PROVIDER_INVALID_OUTPUT",
    };
  }
  const record = JSON.stringify({ calls, sources: [...sources.values()] });
  await transaction(async (c) => {
    if (outcome.ok) {
      await c.query(
        `UPDATE assistant_turns SET status='succeeded',answer=$2,model=$3,input_tokens=$4,output_tokens=$5,
        cost_micros=$6,tools=$7,completed_at=now() WHERE id=$1`,
        [
          started.id,
          outcome.answer,
          outcome.model,
          outcome.inputTokens,
          outcome.outputTokens,
          costMicros(outcome.model, outcome.inputTokens, outcome.outputTokens),
          record,
        ],
      );
    } else {
      // Lookups already ran, so a failed turn keeps what was fetched.
      await c.query(
        `UPDATE assistant_turns SET status='failed',error_code=$2,cost_micros=$3,tools=$4,completed_at=now() WHERE id=$1`,
        [
          started.id,
          outcome.code,
          outcome.charge ? started.reserve : 0,
          record,
        ],
      );
    }
    await c.query(
      "UPDATE assistant_conversations SET updated_at=now() WHERE id=$1",
      [started.conversation],
    );
    await c.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      user,
      outcome.ok ? "ai.assistant.answered" : "ai.assistant.failed",
      started.id,
    ]);
  });
  return turnView(started.id, user);
}

async function turnView(id: string, user: string) {
  const { rows } = await pool.query(
    `SELECT t.id,t.conversation_id,t.question,t.answer,t.status,t.error_code,t.tools,t.provider,t.model,t.created_at
    FROM assistant_turns t WHERE t.id=$1 AND t.user_id=$2`,
    [id, user],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  return {
    conversation_id: rows[0].conversation_id as string,
    turn: view(rows[0]),
  };
}
