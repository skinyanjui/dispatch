import test, { after, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../../src/lib/db";
import { POST, GET } from "../../src/app/api/[...path]/route";
import { carrierDocuments, uploadDocument } from "../../src/lib/documents";
import { detail, mutate } from "../../src/lib/loads";
import {
  anthropicProvider,
  costMicros,
  fixtureProvider,
  ProviderError,
  reserveMicros,
  setExtractionProvider,
  type ExtractionProvider,
} from "../../src/lib/ai";
import {
  aiStatus,
  checkExtraction,
  dismissExtraction,
  requestExtraction,
  saveAiSettings,
} from "../../src/lib/extractions";
import {
  extractionChecks,
  resultSchema,
  type Suggestions,
} from "../../src/lib/extraction";
import { bookedLoad, pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("AiReading");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
});
afterEach(() => setExtractionProvider(undefined));
after(() => pool.end());

/** Counts calls so tests can prove when the model was (not) used. */
function counting(base = fixtureProvider()) {
  const provider: ExtractionProvider & { calls: number } = {
    calls: 0,
    name: base.name,
    model: base.model,
    async read(input) {
      provider.calls++;
      return base.read(input);
    },
  };
  return provider;
}
const enable = async (limitCents = 1000) => {
  const status = await aiStatus(t.dispatcher, t.organization);
  await saveAiSettings(t.dispatcher, t.organization, {
    version: status.version,
    enabled: true,
    monthly_limit_cents: limitCents,
  });
};
const disable = async () => {
  const status = await aiStatus(t.dispatcher, t.organization);
  await saveAiSettings(t.dispatcher, t.organization, {
    version: status.version,
    enabled: false,
    monthly_limit_cents: status.monthly_limit_cents,
  });
};
const insurance = async (name = "cert.pdf") =>
  uploadDocument(
    t.dispatcher,
    {
      idempotency_key: randomUUID(),
      carrier_id: t.carrier,
      type: "insurance_auto_liability",
      expires_on: "2027-03-01",
    },
    { name, bytes: pdf() },
  );
const rateConfirmation = async () => {
  const load = await bookedLoad(t.dispatcher, t.carrier);
  const file = await uploadDocument(
    t.dispatcher,
    {
      idempotency_key: randomUUID(),
      carrier_id: t.carrier,
      type: "rate_confirmation",
      load_id: load.id,
    },
    { name: "rc.pdf", bytes: pdf() },
  );
  return { load, file };
};
const audit = async (resource: string) =>
  (
    await pool.query(
      "SELECT action FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
      [resource],
    )
  ).rows.map((r) => r.action as string);

test("reading is off until an owner or admin turns it on", async () => {
  const provider = counting();
  setExtractionProvider(provider);
  const file = await insurance();
  await assert.rejects(
    requestExtraction(t.dispatcher, file.version_id, randomUUID()),
    { code: "AI_NOT_ENABLED" },
  );
  assert.equal(provider.calls, 0, "no file left before consent");
  const slots = (await carrierDocuments(t.dispatcher, t.carrier)).slots;
  const slot = slots.find((s) => s.type === "insurance_auto_liability")!;
  assert.equal(slot.current?.can_read_with_ai, false);
  // A carrier manager cannot give the organization's consent.
  await assert.rejects(
    saveAiSettings(t.manager, t.organization, {
      version: 0,
      enabled: true,
      monthly_limit_cents: 500,
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    saveAiSettings(t.foreignManager, t.organization, {
      version: 0,
      enabled: true,
      monthly_limit_cents: 500,
    }),
    { code: "NOT_FOUND" },
  );
});

test("consent needs a configured model, an up-to-date version and is audited", async () => {
  setExtractionProvider(null);
  await assert.rejects(
    saveAiSettings(t.dispatcher, t.organization, {
      version: 0,
      enabled: true,
      monthly_limit_cents: 500,
    }),
    { code: "AI_UNAVAILABLE" },
  );
  setExtractionProvider(fixtureProvider());
  const before = await aiStatus(t.dispatcher, t.organization);
  assert.equal(before.available, true);
  await enable(500);
  await assert.rejects(
    saveAiSettings(t.dispatcher, t.organization, {
      version: before.version,
      enabled: false,
      monthly_limit_cents: 500,
    }),
    { code: "VERSION_CONFLICT" },
  );
  assert.ok((await audit(t.organization)).includes("ai.extraction.enabled"));
  await disable();
  assert.ok((await audit(t.organization)).includes("ai.extraction.disabled"));
});

test("a reading is stored as a suggestion and changes nothing else", async () => {
  const provider = counting();
  setExtractionProvider(provider);
  await enable();
  const { load, file } = await rateConfirmation();
  const loadBefore = await detail(t.dispatcher, load.id);
  const counts = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM document_versions WHERE carrier_id=$1) versions,
          (SELECT count(*) FROM document_reviews WHERE carrier_id=$1) reviews,
          (SELECT count(*) FROM carrier_billing_packets WHERE carrier_id=$1) packets`,
        [t.carrier],
      )
    ).rows[0];
  const before = await counts();
  const done = await requestExtraction(
    t.dispatcher,
    file.version_id,
    randomUUID(),
  );
  assert.equal(done.status, "succeeded");
  assert.equal(done.provider, "fixture");
  assert.equal(done.fields?.rate_minor?.value, 260000);
  assert.deepEqual(
    await counts(),
    before,
    "no document, review or billing change",
  );
  const after = await detail(t.dispatcher, load.id);
  assert.equal(after.amount_minor, loadBefore.amount_minor);
  assert.equal(after.version, loadBefore.version);
  assert.equal(after.stage, loadBefore.stage);
  // The suggestion rides with the document the interface already loads.
  const slot = after.documents.find(
    (s: { type: string }) => s.type === "rate_confirmation",
  );
  assert.equal(slot.current.extraction.id, done.id);
  assert.equal(slot.current.can_read_with_ai, true);
  assert.deepEqual(await audit(done.id), [
    "ai.extraction.requested",
    "ai.extraction.completed",
  ]);
  const row = (
    await pool.query("SELECT * FROM document_extractions WHERE id=$1", [
      done.id,
    ])
  ).rows[0];
  assert.equal(row.prompt_version.length > 0, true);
  assert.equal(String(row.cost_micros), "0");
});

test("a repeated key, or a second request, never pays for another reading", async () => {
  const provider = counting();
  setExtractionProvider(provider);
  await enable();
  const file = await insurance();
  const key = randomUUID();
  const first = await requestExtraction(t.dispatcher, file.version_id, key);
  const again = await requestExtraction(t.dispatcher, file.version_id, key);
  const other = await requestExtraction(
    t.dispatcher,
    file.version_id,
    randomUUID(),
  );
  assert.equal(again.id, first.id);
  assert.equal(other.id, first.id);
  assert.equal(provider.calls, 1);
  const second = await insurance("other.pdf");
  await assert.rejects(
    requestExtraction(t.dispatcher, second.version_id, key),
    {
      code: "IDEMPOTENCY_CONFLICT",
    },
  );
  await assert.rejects(requestExtraction(t.dispatcher, file.version_id, ""), {
    code: "IDEMPOTENCY_KEY_REQUIRED",
  });
});

test("only the current version can be read", async () => {
  setExtractionProvider(counting());
  await enable();
  const first = await insurance();
  await uploadDocument(
    t.dispatcher,
    {
      idempotency_key: randomUUID(),
      carrier_id: t.carrier,
      type: "insurance_auto_liability",
      expires_on: "2027-04-01",
    },
    { name: "newer.pdf", bytes: pdf() },
  );
  await assert.rejects(
    requestExtraction(t.dispatcher, first.version_id, randomUUID()),
    { code: "DOCUMENT_SUPERSEDED" },
  );
});

test("tax forms and dispatch agreements are never sent", async () => {
  const provider = counting();
  setExtractionProvider(provider);
  await enable();
  for (const type of ["w9", "dispatch_agreement"]) {
    const file = await uploadDocument(
      t.dispatcher,
      { idempotency_key: randomUUID(), carrier_id: t.carrier, type },
      { name: type + ".pdf", bytes: pdf() },
    );
    await assert.rejects(
      requestExtraction(t.dispatcher, file.version_id, randomUUID()),
      { code: "NOT_READABLE" },
    );
  }
  assert.equal(provider.calls, 0);
});

test("foreign tenants, drivers and guessed ids get 404", async () => {
  const provider = counting();
  setExtractionProvider(provider);
  await enable();
  const { file } = await rateConfirmation();
  const done = await requestExtraction(
    t.dispatcher,
    file.version_id,
    randomUUID(),
  );
  for (const user of [t.foreignManager, t.driverUser]) {
    await assert.rejects(
      requestExtraction(user, file.version_id, randomUUID()),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(checkExtraction(user, done.id, { fields: {} }), {
      code: "NOT_FOUND",
    });
    await assert.rejects(dismissExtraction(user, done.id), {
      code: "NOT_FOUND",
    });
  }
  const token = await sessionFor(t.foreignManager);
  for (const [path, json] of [
    [`documents/${file.version_id}/read`, {}],
    [`extractions/${done.id}/check`, { fields: {} }],
    [`extractions/${done.id}/dismiss`, {}],
    [
      `organizations/${t.organization}/ai`,
      { version: 1, enabled: true, monthly_limit_cents: 1 },
    ],
  ] as const) {
    const response = await POST(
      request(path, {
        token,
        json,
        headers: { "idempotency-key": randomUUID() },
      }),
    );
    assert.equal(response.status, 404, path);
  }
  const status = await GET(
    request(`organizations/${t.organization}/ai`, { token }),
  );
  assert.equal(status.status, 404);
  assert.equal(provider.calls, 1);
});

test("the monthly limit is held before the call and shared by concurrent requests", async () => {
  // A paid model, so the limit and the held cost actually matter.
  const paid: ExtractionProvider & { calls: number } = {
    calls: 0,
    name: "test",
    model: "claude-opus-5-5",
    async read(input) {
      paid.calls++;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const out = await fixtureProvider().read(input);
      return {
        ...out,
        model: "claude-opus-5-5",
        inputTokens: 1000,
        outputTokens: 500,
      };
    },
  };
  const provider = paid;
  setExtractionProvider(paid);
  await pool.query(
    "DELETE FROM document_extractions WHERE organization_id=$1",
    [t.organization],
  );
  const file = await insurance("budget.pdf");
  // Zero dollars: refused before any file leaves the system.
  await enable(0);
  await assert.rejects(
    requestExtraction(t.dispatcher, file.version_id, randomUUID()),
    { code: "AI_BUDGET_REACHED" },
  );
  assert.equal(provider.calls, 0);
  // Room for exactly one held reservation.
  const hold = reserveMicros("claude-opus-5-5", 0);
  const cents = Math.ceil(hold / 10_000) + 1;
  await pool.query(
    "DELETE FROM document_extractions WHERE organization_id=$1",
    [t.organization],
  );
  const status = await aiStatus(t.dispatcher, t.organization);
  await saveAiSettings(t.dispatcher, t.organization, {
    version: status.version,
    enabled: true,
    monthly_limit_cents: cents,
  });
  const a = await insurance("a.pdf");
  const b = await rateConfirmation();
  const results = await Promise.allSettled([
    requestExtraction(t.dispatcher, a.version_id, randomUUID()),
    requestExtraction(t.dispatcher, b.file.version_id, randomUUID()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const refused = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(refused.reason.code, "AI_BUDGET_REACHED");
  // The real cost (14,000 micro-dollars for 1,000 in / 500 out) replaces the hold.
  assert.equal(costMicros("claude-opus-5-5", 1000, 500), 14000);
  const spent = (await aiStatus(t.dispatcher, t.organization)).spent_cents;
  assert.equal(spent, 2);
});

test("failures are recorded, can be retried, and stop after three", async () => {
  await pool.query(
    "DELETE FROM document_extractions WHERE organization_id=$1",
    [t.organization],
  );
  const failing = counting(fixtureProvider());
  setExtractionProvider(failing);
  await enable();
  const file = await insurance("fail.pdf");
  for (let i = 0; i < 3; i++) {
    const result = await requestExtraction(
      t.dispatcher,
      file.version_id,
      randomUUID(),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "PROVIDER_UNAVAILABLE");
    assert.equal(result.fields, null);
  }
  await assert.rejects(
    requestExtraction(t.dispatcher, file.version_id, randomUUID()),
    { code: "TOO_MANY_ATTEMPTS" },
  );
  const costs = await pool.query(
    "SELECT cost_micros FROM document_extractions WHERE version_id=$1",
    [file.version_id],
  );
  assert.ok(costs.rows.every((r) => String(r.cost_micros) === "0"));
});

test("a person can check or dismiss a reading, and dismissing allows a new one", async () => {
  const provider = counting();
  setExtractionProvider(provider);
  await enable();
  const file = await insurance("check.pdf");
  const done = await requestExtraction(
    t.dispatcher,
    file.version_id,
    randomUUID(),
  );
  const checked = await checkExtraction(t.dispatcher, done.id, {
    fields: { expiry_date: "2027-03-01" },
  });
  assert.ok(checked.checked_at);
  assert.equal(checked.checked_by_name !== null, true);
  assert.deepEqual(checked.checked_fields, { expiry_date: "2027-03-01" });
  await assert.rejects(
    checkExtraction(t.dispatcher, done.id, { fields: { x: { nested: 1 } } }),
  );
  await dismissExtraction(t.dispatcher, done.id);
  const slot = (await carrierDocuments(t.dispatcher, t.carrier)).slots.find(
    (s) => s.current?.id === file.version_id,
  )!;
  assert.equal(slot.current?.extraction ?? null, null);
  const again = await requestExtraction(
    t.dispatcher,
    file.version_id,
    randomUUID(),
  );
  assert.notEqual(again.id, done.id);
  assert.equal(provider.calls, 2);
  assert.ok((await audit(done.id)).includes("ai.extraction.dismissed"));
});

test("results are validated and compared with Relay's records in plain code", () => {
  assert.equal(
    resultSchema("pod").safeParse({
      delivered_date: { value: "Nov 5", confidence: "high", quote: "x" },
      receiver_name: { value: null, confidence: "low", quote: "" },
      signed: { value: true, confidence: "high", quote: "sig" },
      exceptions_noted: { value: null, confidence: "high", quote: "" },
    }).success,
    false,
    "dates must be YYYY-MM-DD",
  );
  assert.equal(
    resultSchema("rate_confirmation").safeParse({
      reference: { value: "A", confidence: "high", quote: "A" },
      broker_name: { value: "B", confidence: "high", quote: "B" },
      rate_minor: { value: 2600.5, confidence: "high", quote: "$26" },
      pickup_date: { value: null, confidence: "low", quote: "" },
      delivery_date: { value: null, confidence: "low", quote: "" },
    }).success,
    false,
    "money is whole cents",
  );
  const rate: Suggestions = {
    reference: { value: "R1", confidence: "high", quote: "R1" },
    broker_name: { value: "Broker", confidence: "high", quote: "Broker" },
    rate_minor: { value: 260000, confidence: "high", quote: "$2,600.00" },
    pickup_date: { value: "2026-11-05", confidence: "high", quote: "11/5" },
    delivery_date: { value: null, confidence: "low", quote: "" },
  };
  const load = {
    amount_minor: "250000",
    stops: [
      {
        window_start: "2026-11-05T15:00:00.000Z",
        window_end: "2026-11-05T16:00:00.000Z",
        timezone: "America/Chicago",
      },
      {
        window_start: "2026-11-06T15:00:00.000Z",
        window_end: "2026-11-06T16:00:00.000Z",
        timezone: "America/Chicago",
      },
    ],
  };
  const checks = extractionChecks("rate_confirmation", rate, { load });
  assert.equal(checks.find((c) => c.field === "rate_minor")?.level, "differs");
  assert.match(
    checks.find((c) => c.field === "rate_minor")!.message,
    /\$2,600\.00.*\$2,500\.00/,
  );
  assert.equal(checks.find((c) => c.field === "pickup_date")?.level, "ok");
  assert.equal(checks.find((c) => c.field === "delivery_date")?.level, "note");
  const policy: Suggestions = {
    ...Object.fromEntries(
      ["insurer", "policy_number", "named_insured"].map((k) => [
        k,
        { value: "x", confidence: "high", quote: "x" },
      ]),
    ),
    effective_date: { value: "2025-01-01", confidence: "high", quote: "" },
    expiry_date: { value: "2026-12-01", confidence: "high", quote: "" },
    coverage_limit_minor: { value: 100, confidence: "high", quote: "" },
  };
  const insuranceChecks = extractionChecks(
    "insurance_cargo",
    policy,
    { expires_on: "2027-12-01" },
    "2026-10-21",
  );
  assert.match(
    insuranceChecks.find((c) => c.level === "differs")!.message,
    /2026-12-01.*2027-12-01/,
  );
});

test("the Claude request is one file, no tools, and failures map to clear codes", async () => {
  const calls: Record<string, unknown>[] = [];
  const stand = (
    behave: (params: Record<string, unknown>) => unknown,
  ): Pick<Anthropic, "beta"> =>
    ({
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            calls.push(params);
            return behave(params);
          },
        },
      },
    }) as unknown as Pick<Anthropic, "beta">;
  const good = {
    stop_reason: "end_turn",
    model: "claude-opus-5-5",
    usage: { input_tokens: 900, output_tokens: 120 },
    parsed_output: Object.fromEntries(
      ["bol_number", "ship_date", "shipper_name", "consignee_name"].map((k) => [
        k,
        k === "ship_date"
          ? { value: "2026-11-05", confidence: "high", quote: "11/5/26" }
          : { value: "X", confidence: "medium", quote: "X" },
      ]),
    ),
  };
  const input = {
    type: "bol" as const,
    filename: "bol.pdf",
    contentType: "application/pdf" as const,
    bytes: pdf(),
  };
  const ok = await anthropicProvider(
    "key",
    "claude-opus-5-5",
    stand(() => good),
  )!.read(input);
  assert.equal(ok.inputTokens, 900);
  const sent = calls[0] as {
    model: string;
    tools?: unknown;
    fallbacks: string;
    betas: string[];
    system: string;
    messages: { content: { type: string }[] }[];
  };
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.tools, undefined, "the model has no tools");
  assert.equal(sent.fallbacks, "default");
  assert.deepEqual(sent.betas, ["server-side-fallback-2026-07-01"]);
  assert.match(sent.system, /untrusted data/);
  assert.deepEqual(
    sent.messages[0].content.map((b) => b.type),
    ["document", "text"],
  );
  await anthropicProvider(
    "key",
    "m",
    stand(() => good),
  )!.read({
    ...input,
    contentType: "image/png",
  });
  assert.equal(
    (calls[1] as { messages: { content: { type: string }[] }[] }).messages[0]
      .content[0].type,
    "image",
  );
  const fail = (behave: () => unknown) =>
    anthropicProvider("key", "m", stand(behave))!.read(input);
  await assert.rejects(
    fail(() => ({ ...good, stop_reason: "refusal" })),
    {
      code: "PROVIDER_REFUSED",
    },
  );
  await assert.rejects(
    fail(() => ({ ...good, parsed_output: { nope: 1 } })),
    {
      code: "PROVIDER_INVALID_OUTPUT",
    },
  );
  await assert.rejects(
    fail(() => {
      throw new Anthropic.BadRequestError(400, {}, "bad", new Headers());
    }),
    { code: "PROVIDER_REJECTED_FILE" },
  );
  await assert.rejects(
    fail(() => {
      throw new Error("network");
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(anthropicProvider(undefined), null, "no key, no provider");
});

test("prices are integers, rounded up, and unknown models are billed high", () => {
  assert.equal(costMicros("claude-haiku-5-5", 1000, 1000), 600);
  assert.equal(costMicros("claude-haiku-5-5", 1, 1), 1);
  assert.equal(costMicros("some-new-model", 1_000_000, 0), 10_000_000);
  assert.equal(costMicros("fixture", 5000, 5000), 0);
});

test("loads are untouched even when a reading mentions a different rate", async () => {
  setExtractionProvider(counting());
  await enable();
  const { load, file } = await rateConfirmation();
  const loadRow = async () =>
    (
      await pool.query("SELECT amount_minor,version FROM loads WHERE id=$1", [
        load.id,
      ])
    ).rows[0];
  const before = await loadRow();
  await requestExtraction(t.dispatcher, file.version_id, randomUUID());
  assert.deepEqual(await loadRow(), before);
  // The same rate a model suggested is still just a suggestion the dispatcher
  // must apply through the normal, audited edit.
  await mutate(t.dispatcher, load.id, "assign", {
    version: before.version,
    driverId: t.driver,
  });
});
