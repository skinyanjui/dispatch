import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { createLoad } from "../../src/lib/loads";
import { aiStatus, saveAiSettings } from "../../src/lib/extractions";
import {
  anthropicProvider,
  fixtureProvider,
  ProviderError,
  setExtractionProvider,
  type ExtractionProvider,
} from "../../src/lib/ai";
import { rateReadStatus, readRateConfirmation } from "../../src/lib/rate-reads";
import {
  centsToDollars,
  rateDraft,
  stateOf,
  zoneFor,
} from "../../src/lib/rate-draft";
import { sampleSuggestions, type Suggestions } from "../../src/lib/extraction";
import { pdf, request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let unauthorized: string;
before(async () => {
  t = await tenant("RateRead");
  other = await tenant("RateRead other");
  for (const x of [t, other])
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [x.organization, x.dispatcher],
    );
  // A carrier with no verified dispatch agreement.
  unauthorized = randomUUID();
  await pool.query(
    "INSERT INTO carriers VALUES($1,$2,'No agreement carrier')",
    [unauthorized, t.organization],
  );
  await pool.query("INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)", [
    t.dispatcher,
    unauthorized,
  ]);
  setExtractionProvider(fixtureProvider());
});
afterEach(() => setExtractionProvider(fixtureProvider()));
after(() => pool.end());

const enable = async (x = t, on = true, cents = 1000) => {
  const s = await aiStatus(x.dispatcher, x.organization);
  await saveAiSettings(x.dispatcher, x.organization, {
    version: s.version,
    enabled: on,
    monthly_limit_cents: cents,
  });
};
const file = (label = "rc") => ({
  name: label + ".pdf",
  bytes: Buffer.from(`%PDF-1.4\n% fictional ${label} ${randomUUID()}\n%%EOF\n`),
});
const read = (user: string, carrier: string, f = file(), key = randomUUID()) =>
  readRateConfirmation(user, { carrier_id: carrier, idempotency_key: key }, f);
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    if ((e as Error).name === "ZodError") return 400;
    return (e as { status?: number }).status ?? 500;
  }
};
const loadFrom = (
  readId: string | undefined,
  carrier = t.carrier,
  reference = "RC-" + randomUUID().slice(0, 8),
) => {
  const start = Date.now() + 3 * 86_400_000;
  return createLoad(
    t.dispatcher,
    {
      carrierId: carrier,
      reference,
      source: "Sample Freight Brokers",
      amountMinor: 250000,
      ...(readId ? { readId } : {}),
      stops: [
        {
          kind: "pickup",
          address: "Chicago, IL",
          timezone: "America/Chicago",
          windowStart: new Date(start).toISOString(),
          windowEnd: new Date(start).toISOString(),
        },
        {
          kind: "delivery",
          address: "Nashville, TN",
          timezone: "America/Chicago",
          windowStart: new Date(start + 86_400_000).toISOString(),
          windowEnd: new Date(start + 86_400_000).toISOString(),
        },
      ],
    },
    randomUUID(),
  );
};

test("the draft maps a reading to form values and says what to check", () => {
  const draft = rateDraft(sampleSuggestions("rate_confirmation_load"));
  assert.equal(draft.reference, "SAMPLE-RC-1001");
  assert.equal(draft.source, "Sample Freight Brokers · SAMPLE-RC-1001");
  assert.equal(draft.amount, "2500.00");
  assert.deepEqual(
    draft.stops.map((s) => [s.kind, s.zone]),
    [
      ["pickup", "America/Chicago"],
      ["delivery", "America/Chicago"],
    ],
  );
  assert.match(draft.stops[0].appointment, /^\d{4}-\d{2}-\d{2}T09:00$/);
  // Time zones are always a guess to check; a model never decides them.
  assert.ok(draft.flags.stop1_zone && draft.flags.stop2_zone);
  assert.equal(draft.flags.amount?.level, "check");
  // Money is integer cents all the way, never floating point.
  assert.equal(centsToDollars(250_001), "2500.01");
  assert.equal(centsToDollars(5), "0.05");
  assert.equal(centsToDollars(100_000_000_000_000), "1000000000000.00");
});

test("states give time zones; unclear stops and missing values are flagged", () => {
  assert.equal(stateOf("Dock 4, Nashville, TN 37201"), "TN");
  assert.equal(zoneFor("Denver, CO"), "America/Denver");
  assert.equal(zoneFor("Phoenix, AZ 85001"), "America/Phoenix");
  assert.equal(zoneFor("Somewhere unclear"), "America/Chicago");
  const s = (
    value: string | number | null,
    confidence: "high" | "medium" | "low" = "high",
  ) => ({ value, confidence, quote: value === null ? "" : String(value) });
  const none = s(null);
  const fields = {
    reference: s(null),
    broker_name: s("Acme Brokers", "low"),
    rate_minor: s(null),
    stop1_kind: s("drop"),
    stop1_address: s("Dock 2, Memphis, TN"),
    stop1_appointment: s("2020-01-01T08:00"),
    stop2_kind: s("pickup"),
    stop2_address: s("Atlanta, GA"),
    stop2_appointment: s("not a time"),
    ...Object.fromEntries(
      [3, 4].flatMap((n) => [
        [`stop${n}_kind`, none],
        [`stop${n}_address`, none],
        [`stop${n}_appointment`, none],
      ]),
    ),
  } as Suggestions;
  const draft = rateDraft(fields);
  assert.equal(draft.reference, "");
  assert.equal(draft.amount, "");
  assert.equal(draft.flags.reference.level, "missing");
  assert.equal(draft.flags.amount.level, "missing");
  assert.equal(draft.flags.source.level, "check");
  // A load starts at a pickup and ends at a delivery whatever the model said.
  assert.deepEqual(
    draft.stops.map((s) => s.kind),
    ["pickup", "delivery"],
  );
  assert.equal(draft.stops[1].appointment, "");
  assert.equal(draft.flags.stop2_appointment.level, "missing");
  assert.match(draft.flags.stop1_appointment.message, /in the past/);
  assert.ok(draft.notes.some((n) => /first stop|last stop/.test(n)));
  // Fewer than two stops still gives a usable form.
  const sparse = rateDraft({ ...fields, stop2_address: none } as Suggestions);
  assert.equal(sparse.stops.length, 2);
  assert.ok(sparse.notes.some((n) => /Fewer than two stops/.test(n)));
});

test("reading needs AI turned on, a dispatcher, and a carrier with a verified agreement", async () => {
  assert.equal(await status(read(t.dispatcher, t.carrier)), 403);
  const before = await rateReadStatus(t.dispatcher, t.carrier);
  assert.deepEqual(
    [before.enabled, before.can_enable, before.available],
    [false, true, true],
  );
  await enable();
  assert.equal((await rateReadStatus(t.dispatcher, t.carrier)).enabled, true);
  // Drivers, a manager of a different carrier and other organizations' staff
  // get NOT_FOUND, even for guessed IDs.
  for (const user of [t.driverUser, t.foreignManager, other.dispatcher]) {
    assert.equal(await status(read(user, t.carrier)), 404);
    assert.equal(await status(rateReadStatus(user, t.carrier)), 404);
  }
  // A carrier's own manager can create its loads, so can read for them, but
  // cannot change the organization's AI settings.
  const manager = await rateReadStatus(t.manager, t.carrier);
  assert.deepEqual([manager.enabled, manager.can_enable], [true, false]);
  // No verified agreement: no reading and no spend.
  assert.equal(await status(read(t.dispatcher, unauthorized)), 422);
  const spent = await pool.query(
    "SELECT count(*)::int n FROM rate_confirmation_reads WHERE carrier_id=$1",
    [unauthorized],
  );
  assert.equal(spent.rows[0].n, 0);
  // Bad input.
  assert.equal(
    await status(
      readRateConfirmation(
        t.dispatcher,
        { carrier_id: t.carrier, idempotency_key: randomUUID() },
        null,
      ),
    ),
    400,
  );
  assert.equal(
    await status(
      readRateConfirmation(
        t.dispatcher,
        { carrier_id: t.carrier, idempotency_key: randomUUID() },
        { name: "x.txt", bytes: Buffer.from("not a pdf") },
      ),
    ),
    415,
  );
  assert.equal(
    await status(
      readRateConfirmation(
        t.dispatcher,
        { carrier_id: t.carrier, key: 1 },
        file(),
      ),
    ),
    400,
  );
});

test("a reading returns a draft, stores provenance, and creates nothing", async () => {
  await enable();
  const loads = async () =>
    Number(
      (
        await pool.query("SELECT count(*) FROM loads WHERE carrier_id=$1", [
          t.carrier,
        ])
      ).rows[0].count,
    );
  const before = await loads();
  const result = await read(t.dispatcher, t.carrier, file("first"));
  assert.equal(result.status, "succeeded");
  assert.equal(result.provider, "fixture");
  assert.equal(result.draft?.reference, "SAMPLE-RC-1001");
  assert.equal(await loads(), before);
  const row = await pool.query(
    "SELECT sha256,size_bytes,cost_micros,load_id,prompt_version FROM rate_confirmation_reads WHERE id=$1",
    [result.id],
  );
  assert.match(row.rows[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(Number(row.rows[0].cost_micros), 0);
  assert.equal(row.rows[0].load_id, null);
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
    [result.id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ["ai.rate_read.requested", "ai.rate_read.completed"],
  );
});

test("retries replay, a different file under the same key conflicts, and failures can be retried", async () => {
  await enable();
  const key = randomUUID();
  const f = file("same");
  const a = await read(t.dispatcher, t.carrier, f, key);
  const b = await read(t.dispatcher, t.carrier, f, key);
  assert.equal(a.id, b.id);
  assert.equal(
    await status(read(t.dispatcher, t.carrier, file("different"), key)),
    409,
  );
  const n = await pool.query(
    "SELECT count(*)::int n FROM rate_confirmation_reads WHERE requested_by=$1 AND idempotency_key=$2",
    [t.dispatcher, key],
  );
  assert.equal(n.rows[0].n, 1);
  // An outage costs nothing and shows a reason; a refusal keeps its hold.
  let mode: "down" | "refuse" | "ok" = "down";
  const stand: ExtractionProvider = {
    name: "stand-in",
    model: "claude-opus-5-5",
    async read(input) {
      if (mode === "down") throw new ProviderError("PROVIDER_UNAVAILABLE");
      if (mode === "refuse") throw new ProviderError("PROVIDER_REFUSED");
      return {
        fields: sampleSuggestions(input.type),
        model: "claude-opus-5-5",
        inputTokens: 2000,
        outputTokens: 300,
      };
    },
  };
  setExtractionProvider(stand);
  const down = await read(t.dispatcher, t.carrier);
  assert.deepEqual(
    [down.status, down.error_code, down.draft],
    ["failed", "PROVIDER_UNAVAILABLE", null],
  );
  mode = "refuse";
  const refused = await read(t.dispatcher, t.carrier);
  const kept = await pool.query(
    "SELECT cost_micros,reserved_micros FROM rate_confirmation_reads WHERE id=$1",
    [refused.id],
  );
  assert.equal(kept.rows[0].cost_micros, kept.rows[0].reserved_micros);
  mode = "ok";
  const good = await read(t.dispatcher, t.carrier);
  assert.equal(good.status, "succeeded");
  const cost = await pool.query(
    "SELECT cost_micros FROM rate_confirmation_reads WHERE id=$1",
    [good.id],
  );
  assert.equal(
    Number(cost.rows[0].cost_micros),
    Math.ceil((2000 * 4_000_000 + 300 * 20_000_000) / 1_000_000),
  );
});

test("the shared monthly limit stops a reading before any model call", async () => {
  await enable(t, true, 1);
  let calls = 0;
  setExtractionProvider({
    name: "stand-in",
    model: "claude-opus-5-5",
    async read(i) {
      calls++;
      return {
        fields: sampleSuggestions(i.type),
        model: "claude-opus-5-5",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  });
  assert.equal(await status(read(t.dispatcher, t.carrier)), 402);
  assert.equal(calls, 0);
  await enable(t, true, 1000);
});

test("the Anthropic provider's output is validated before a draft is made", async () => {
  await enable();
  const make = (fields: unknown) =>
    ({
      beta: {
        messages: {
          parse: async () => ({
            stop_reason: "end_turn",
            parsed_output: fields,
            model: "claude-opus-5-5",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        },
      },
    }) as unknown as Pick<Anthropic, "beta">;
  setExtractionProvider(
    anthropicProvider(
      "key",
      "claude-opus-5-5",
      make(sampleSuggestions("rate_confirmation_load")),
    ),
  );
  assert.equal((await read(t.dispatcher, t.carrier)).status, "succeeded");
  const bad = structuredClone(sampleSuggestions("rate_confirmation_load"));
  bad.stop1_appointment = {
    value: "next Tuesday 9am",
    confidence: "high",
    quote: "next Tuesday",
  };
  setExtractionProvider(anthropicProvider("key", "claude-opus-5-5", make(bad)));
  const invalid = await read(t.dispatcher, t.carrier);
  assert.deepEqual(
    [invalid.status, invalid.error_code],
    ["failed", "PROVIDER_INVALID_OUTPUT"],
  );
});

test("a load created from a reading is linked once, and only by the person who read it", async () => {
  await enable();
  const r = await read(t.dispatcher, t.carrier);
  const load = await loadFrom(r.id);
  const linked = await pool.query(
    "SELECT load_id FROM rate_confirmation_reads WHERE id=$1",
    [r.id],
  );
  assert.equal(linked.rows[0].load_id, load.id);
  const audit = await pool.query(
    "SELECT 1 FROM audit_logs WHERE resource_id=$1 AND action='ai.rate_read.used'",
    [r.id],
  );
  assert.equal(audit.rowCount, 1);
  // The same reading cannot start a second load.
  assert.equal(await status(loadFrom(r.id)), 409);
  // Someone else's reading, another carrier's, or a made-up one is NOT_FOUND and creates no load.
  const mine = await read(t.dispatcher, t.carrier);
  const count = async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM loads WHERE carrier_id IN ($1,$2)",
          [t.carrier, t.foreign],
        )
      ).rows[0].count,
    );
  const before = await count();
  assert.equal(await status(loadFrom(mine.id, t.foreign)), 404);
  assert.equal(await status(loadFrom(randomUUID())), 404);
  await pool.query(
    "UPDATE rate_confirmation_reads SET requested_by=$2 WHERE id=$1",
    [mine.id, t.manager],
  );
  assert.equal(await status(loadFrom(mine.id)), 404);
  assert.equal(await count(), before);
  // A load without a reading is unchanged.
  assert.ok((await loadFrom(undefined)).id);
});

test("HTTP: multipart upload, status and the same rules", async () => {
  await enable();
  const token = await sessionFor(t.dispatcher);
  assert.equal(
    (await GET(request("rate-confirmations/status?carrier_id=" + t.carrier)))
      .status,
    401,
  );
  const state = await GET(
    request("rate-confirmations/status?carrier_id=" + t.carrier, { token }),
  );
  assert.equal((await state.json()).enabled, true);
  const form = new FormData();
  form.set("carrier_id", t.carrier);
  form.set("idempotency_key", randomUUID());
  form.set(
    "file",
    new Blob([new Uint8Array(pdf(randomUUID()))], { type: "application/pdf" }),
    "rc.pdf",
  );
  const res = await POST(
    request("rate-confirmations/read", { token, body: form }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "succeeded");
  assert.equal(body.draft.amount, "2500.00");
  const managerToken = await sessionFor(t.foreignManager);
  assert.equal(
    (
      await GET(
        request("rate-confirmations/status?carrier_id=" + t.carrier, {
          token: managerToken,
        }),
      )
    ).status,
    404,
  );
});
