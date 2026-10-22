import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { ask } from "../../src/lib/assistant";
import {
  fixtureAssistant,
  setAssistantProvider,
} from "../../src/lib/assistant-ai";
import { runTool, toolDefinitions } from "../../src/lib/assistant-tools";
import { aiStatus, saveAiSettings } from "../../src/lib/extractions";
import { bookedLoad, request, sessionFor, tenant } from "./fixtures";

process.env.RELAY_DATA_KEY ||= randomBytes(32).toString("base64");
after(() => pool.end());
let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let load: { id: string; reference: string };
before(async () => {
  t = await tenant("Drafts");
  other = await tenant("DraftsOther");
  for (const x of [t, other])
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [x.organization, x.dispatcher],
    );
  load = await bookedLoad(t.dispatcher, t.carrier);
  setAssistantProvider(fixtureAssistant());
});
const call = async (user: string, path: string, json?: unknown) =>
  (json === undefined ? GET : POST)(
    request(path, {
      token: await sessionFor(user),
      ...(json === undefined ? {} : { json }),
    }),
  );
const newTemplate = async (over: Record<string, unknown> = {}) => {
  const res = await call(t.dispatcher, "document-templates", {
    name: "Check call " + randomUUID().slice(0, 6),
    target: "load",
    body: "Hi {{load.driver}}, checking on {{load.reference}} for {{load.carrier}}. {{sender.name}}",
    ...over,
  });
  return { res, body: await res.clone().json() };
};

test("a template is validated, unique by name, and visible only to its organization", async () => {
  const name = "Update " + randomUUID().slice(0, 6);
  const made = await newTemplate({ name });
  assert.equal(made.res.status, 201);
  assert.equal((await newTemplate({ name })).res.status, 409);
  for (const body of [
    "",
    "x".repeat(8001),
    "Hi {{load.password}}",
    "Hi {{carrier.name}}",
  ])
    assert.equal(
      (await newTemplate({ body })).res.status,
      body.includes("carrier.name") ? 400 : 400,
      body.slice(0, 20),
    );
  const seen = await (await call(t.dispatcher, "document-templates")).json();
  assert.ok(seen.templates.some((x: { name: string }) => x.name === name));
  assert.ok(seen.fields.load["load.reference"]);
  const stranger = await (
    await call(other.dispatcher, "document-templates")
  ).json();
  assert.ok(!stranger.templates.some((x: { name: string }) => x.name === name));
  // Update needs the current version; a stranger gets 404; archive frees the name.
  const id = made.body.id;
  assert.equal(
    (
      await call(t.dispatcher, `document-templates/${id}`, {
        version: 1,
        body: "Hello {{load.reference}}",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(t.dispatcher, `document-templates/${id}`, {
        version: 1,
        body: "Again",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(other.dispatcher, `document-templates/${id}`, {
        version: 2,
        body: "Nope",
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(other.dispatcher, `document-templates/${id}/archive`, {}))
      .status,
    404,
  );
  assert.equal(
    (await call(t.dispatcher, `document-templates/${id}/archive`, {})).status,
    200,
  );
  assert.equal((await newTemplate({ name })).res.status, 201);
  // Drivers and managers who are not staff have no templates.
  assert.equal((await call(t.driverUser, "document-templates")).status, 404);
});

test("generating fills fields, marks missing ones, is idempotent and fixes the text", async () => {
  const tpl = (await newTemplate()).body.id;
  const key = randomUUID();
  const res = await call(t.dispatcher, "drafts/generate", {
    template_id: tpl,
    target_id: load.id,
    idempotency_key: key,
  });
  assert.equal(res.status, 201);
  const { id, missing } = await res.json();
  assert.deepEqual(missing, ["load.driver"]); // no driver is assigned yet
  const again = await call(t.dispatcher, "drafts/generate", {
    template_id: tpl,
    target_id: load.id,
    idempotency_key: key,
  });
  assert.equal((await again.json()).id, id);
  const other2 = await call(t.dispatcher, "drafts/generate", {
    template_id: tpl,
    target_id: randomUUID(),
    idempotency_key: key,
  });
  assert.equal(other2.status, 404);
  const { drafts } = await (await call(t.dispatcher, "drafts")).json();
  const draft = drafts.find((d: { id: string }) => d.id === id);
  assert.match(draft.body, new RegExp(`checking on ${load.reference} for`));
  assert.match(draft.body, /\[missing: load\.driver\]/);
  assert.match(draft.body, /Drafts Dispatcher/);
  assert.equal(draft.status, "draft");
  assert.equal(draft.source, "person");
  // The rendered text cannot be edited, only reviewed.
  await assert.rejects(
    pool.query("UPDATE document_drafts SET body='x' WHERE id=$1", [id]),
  );
  assert.equal(
    (await call(t.dispatcher, `drafts/${id}/approve`, {})).status,
    200,
  );
  assert.equal(
    (await call(t.dispatcher, `drafts/${id}/approve`, {})).status,
    409,
  );
  assert.equal(
    (await call(t.dispatcher, `drafts/${id}/discard`, {})).status,
    409,
  );
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
    [id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ["draft.generated", "draft.approved"],
  );
  // A PDF is made on request: marked as reviewed once approved, never stored.
  const pdf = await GET(
    request(`drafts/${id}/pdf`, { token: await sessionFor(t.dispatcher) }),
  );
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(
    pdf.headers.get("content-disposition") ?? "",
    /attachment; filename="[A-Za-z0-9._-]+\.pdf"/,
  );
  const bytes = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
  assert.ok(bytes.startsWith("%PDF-"));
  assert.match(bytes, /Reviewed by a person/);
  assert.equal(
    (
      await GET(
        request(`drafts/${id}/pdf`, {
          token: await sessionFor(other.dispatcher),
        }),
      )
    ).status,
    404,
  );
  assert.equal((await GET(request(`drafts/${id}/pdf`))).status, 401);
  // Nothing was sent or attached to the load.
  const sent = await pool.query(
    "SELECT count(*)::int n FROM messages m JOIN threads th ON th.id=m.thread_id WHERE th.load_id=$1",
    [load.id],
  );
  assert.equal(sent.rows[0].n, 0);
});

test("other organizations cannot read, generate for or decide on these records", async () => {
  const tpl = (await newTemplate()).body.id;
  const made = await (
    await call(t.dispatcher, "drafts/generate", {
      template_id: tpl,
      target_id: load.id,
      idempotency_key: randomUUID(),
    })
  ).json();
  // A template from another organization cannot be used.
  assert.equal(
    (
      await call(other.dispatcher, "drafts/generate", {
        template_id: tpl,
        target_id: load.id,
        idempotency_key: randomUUID(),
      })
    ).status,
    404,
  );
  const foreignTpl = await (
    await call(other.dispatcher, "document-templates", {
      name: "F",
      target: "load",
      body: "{{load.reference}}",
    })
  ).json();
  // A foreign load cannot be filled in, even with the caller's own template.
  assert.equal(
    (
      await call(other.dispatcher, "drafts/generate", {
        template_id: foreignTpl.id,
        target_id: load.id,
        idempotency_key: randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(other.dispatcher, `drafts/${made.id}/approve`, {})).status,
    404,
  );
  const theirs = await (await call(other.dispatcher, "drafts")).json();
  assert.ok(!theirs.drafts.some((d: { id: string }) => d.id === made.id));
  assert.equal((await call(t.driverUser, "drafts")).status, 404);
  assert.equal((await GET(request("drafts"))).status, 401);
});

test("the assistant drafts from a template, says nothing was sent, and stays inside the organization", async () => {
  const status = await aiStatus(t.dispatcher, t.organization);
  await saveAiSettings(t.dispatcher, t.organization, {
    version: status.version,
    enabled: status.enabled,
    assistant_enabled: true,
    monthly_limit_cents: 1000,
  });
  assert.ok(toolDefinitions.some((d) => d.name === "draft_document"));
  const name = "Broker update " + randomUUID().slice(0, 5);
  await newTemplate({
    name,
    body: "Update on {{load.reference}} ({{load.stage}}) from {{sender.name}}.",
  });
  const result = await ask(
    t.dispatcher,
    { question: `Draft the ${name} for ${load.reference}` },
    randomUUID(),
  );
  assert.equal(result.turn.status, "succeeded");
  assert.match(
    result.turn.answer ?? "",
    /Nothing was sent/,
    result.turn.answer ?? "",
  );
  const source = result.turn.sources.find((s) => s.kind === "document");
  assert.ok(source, "a document source");
  const draft = (
    await pool.query("SELECT * FROM document_drafts WHERE id=$1", [source!.id])
  ).rows[0];
  assert.equal(draft.source, "assistant");
  assert.equal(draft.status, "draft"); // a person still has to review it
  assert.match(draft.body, new RegExp(load.reference));
  // Same request again in the same minute makes no second draft.
  const key = `${t.dispatcher}|${draft.template_id}|${load.id}`;
  void key;
  const run = () =>
    runTool(t.dispatcher, t.organization, "draft_document", {
      template: name,
      record: load.reference,
    });
  const a = await run(),
    b = await run();
  assert.equal(
    (a.sources[0] as { id: string }).id,
    (b.sources[0] as { id: string }).id,
  );
  // A load from another organization looks like it does not exist.
  const foreign = await bookedLoad(other.dispatcher, other.carrier);
  await assert.rejects(
    runTool(t.dispatcher, t.organization, "draft_document", {
      template: name,
      record: foreign.reference,
    }),
    /No load matches/,
  );
  await assert.rejects(
    runTool(t.dispatcher, t.organization, "draft_document", {
      template: "nope",
      record: load.reference,
    }),
    /No such template/,
  );
});
