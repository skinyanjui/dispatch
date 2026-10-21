import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import {
  archiveProspect,
  convertProspect,
  createProspect,
  getProspect,
  listProspects,
  logActivity,
  moveProspect,
  updateProspect,
} from "../../src/lib/prospects";
import { request, sessionFor, tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Prospects");
  other = await tenant("Prospects other");
});
after(() => pool.end());

const prospect = (over: Record<string, unknown> = {}) => ({
  idempotency_key: randomUUID(),
  company: "Fictional Freight LLC",
  contact_name: "Riley Owner",
  email: "Riley@Fictional.TEST",
  phone: "(214) 555-0123",
  usdot: "1234567",
  truck_count: 4,
  source: "referral",
  ...over,
});
const make = async (over: Record<string, unknown> = {}) =>
  (await createProspect(t.dispatcher, prospect(over))).id;
const none = new URLSearchParams();
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    // The route turns validation errors into 400.
    if ((e as Error).name === "ZodError") return 400;
    return (e as { status?: number }).status ?? 500;
  }
};

test("organization staff create, list and read prospects; the rest get NOT_FOUND", async () => {
  const id = await make({ notes: "Met at a trade show" });
  const list = await listProspects(t.dispatcher, none);
  const found = list.prospects.find((p) => p.id === id)!;
  assert.equal(found.stage, "new");
  assert.equal(found.email, "riley@fictional.test");
  assert.equal(list.counts.new >= 1, true);
  assert.deepEqual(
    list.team.map((m) => m.id),
    [t.dispatcher],
  );
  const detail = await getProspect(t.dispatcher, id);
  assert.equal(detail.prospect.notes, "Met at a trade show");
  // Managers, drivers and another organization's dispatcher never see them.
  for (const user of [t.manager, t.driverUser, other.dispatcher]) {
    if (user !== other.dispatcher) {
      // Their own organization's staff may list and create (their own).
      assert.equal(await status(listProspects(user, none)), 404);
      assert.equal(await status(createProspect(user, prospect())), 404);
    }
    assert.equal(await status(getProspect(user, id)), 404);
    assert.equal(
      await status(
        updateProspect(user, id, { company: "Hijacked", version: 1 }),
      ),
      404,
    );
    assert.equal(
      await status(moveProspect(user, id, { stage: "contacted", version: 1 })),
      404,
    );
    assert.equal(
      await status(
        logActivity(user, id, {
          kind: "note",
          body: "hi",
          idempotency_key: randomUUID(),
        }),
      ),
      404,
    );
    assert.equal(await status(convertProspect(user, id, { version: 1 })), 404);
    assert.equal(await status(archiveProspect(user, id, { version: 1 })), 404);
  }
  // Another organization's staff see only their own prospects.
  const foreign = (await createProspect(other.dispatcher, prospect())).id;
  assert.ok(
    !(await listProspects(t.dispatcher, none)).prospects.some(
      (p) => p.id === foreign,
    ),
  );
  assert.equal(await status(getProspect(t.dispatcher, foreign)), 404);
  // Creating in a foreign organization is refused.
  assert.equal(
    await status(
      createProspect(
        t.dispatcher,
        prospect({ organization_id: other.organization }),
      ),
    ),
    404,
  );
});

test("create is idempotent; a changed request with the same key conflicts", async () => {
  const body = prospect();
  const a = await createProspect(t.dispatcher, body);
  const b = await createProspect(t.dispatcher, { ...body });
  assert.equal(a.id, b.id);
  assert.equal(
    await status(
      createProspect(t.dispatcher, { ...body, company: "Another Company" }),
    ),
    409,
  );
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM prospects WHERE created_by=$1 AND idempotency_key=$2",
    [t.dispatcher, body.idempotency_key],
  );
  assert.equal(rows[0].n, 1);
  // Concurrent duplicates still make one row.
  const raced = prospect();
  const ids = await Promise.all(
    [1, 2, 3].map(() => createProspect(t.dispatcher, raced)),
  );
  assert.equal(new Set(ids.map((r) => r.id)).size, 1);
});

test("input is validated: company, email, dollars of nothing, dates, owner", async () => {
  for (const bad of [
    { company: "  " },
    { email: "not-an-email" },
    { usdot: "12ab" },
    { truck_count: -1 },
    { truck_count: 1.5 },
    { source: "billboard" },
    { next_follow_up_on: "2026-02-30" },
    { unknown_field: true },
  ])
    assert.equal(
      await status(createProspect(t.dispatcher, prospect(bad))),
      400,
      JSON.stringify(bad),
    );
  // An owner must be on this organization's team.
  assert.equal(
    await status(
      createProspect(t.dispatcher, prospect({ owner_id: other.dispatcher })),
    ),
    422,
  );
  const ok = await createProspect(
    t.dispatcher,
    prospect({ owner_id: t.dispatcher, next_follow_up_on: "2026-12-01" }),
  );
  const { prospect: p } = await getProspect(t.dispatcher, ok.id);
  assert.equal(p.owner?.id, t.dispatcher);
  assert.equal(p.next_follow_up_on, "2026-12-01");
});

test("edits use optimistic versions", async () => {
  const id = await make();
  const { id: _, ...fields } = { id, ...prospect() };
  void _;
  delete (fields as Record<string, unknown>).idempotency_key;
  const saved = await updateProspect(t.dispatcher, id, {
    ...fields,
    company: "Renamed LLC",
    version: 1,
  });
  assert.equal(saved.version, 2);
  assert.equal(
    await status(updateProspect(t.dispatcher, id, { ...fields, version: 1 })),
    409,
  );
  assert.equal(
    (await getProspect(t.dispatcher, id)).prospect.company,
    "Renamed LLC",
  );
});

test("stage moves are recorded, lost needs a reason, finished prospects drop follow-ups", async () => {
  const id = await make({ next_follow_up_on: "2026-12-01" });
  assert.equal(
    await status(moveProspect(t.dispatcher, id, { stage: "lost", version: 1 })),
    400,
  );
  const moved = await moveProspect(t.dispatcher, id, {
    stage: "contacted",
    version: 1,
  });
  assert.equal(moved.version, 2);
  assert.equal(
    await status(
      moveProspect(t.dispatcher, id, { stage: "qualified", version: 1 }),
    ),
    409,
  );
  const lost = await moveProspect(t.dispatcher, id, {
    stage: "lost",
    lost_reason: "Signed with another dispatcher",
    version: 2,
  });
  assert.equal(lost.version, 3);
  const detail = await getProspect(t.dispatcher, id);
  assert.equal(detail.prospect.stage, "lost");
  assert.equal(detail.prospect.lost_reason, "Signed with another dispatcher");
  assert.equal(detail.prospect.next_follow_up_on, null);
  assert.deepEqual(
    detail.activities.map((a) => a.kind),
    ["stage", "stage"],
  );
  // Reopening clears the reason.
  await moveProspect(t.dispatcher, id, { stage: "new", version: 3 });
  assert.equal((await getProspect(t.dispatcher, id)).prospect.lost_reason, "");
});

test("activity is append-only, idempotent and can set the next follow-up", async () => {
  const id = await make();
  const key = randomUUID();
  const body = {
    kind: "call",
    body: "Left a voicemail",
    next_follow_up_on: "2026-12-05",
    idempotency_key: key,
  };
  await logActivity(t.dispatcher, id, body);
  await logActivity(t.dispatcher, id, body);
  assert.equal(
    await status(
      logActivity(t.dispatcher, id, { ...body, body: "Different text" }),
    ),
    409,
  );
  const detail = await getProspect(t.dispatcher, id);
  assert.equal(detail.activities.length, 1);
  assert.equal(detail.activities[0].actor_name, "Prospects Dispatcher");
  assert.equal(detail.prospect.next_follow_up_on, "2026-12-05");
  assert.equal(
    await status(
      logActivity(t.dispatcher, id, {
        kind: "stage",
        body: "forged",
        idempotency_key: randomUUID(),
      }),
    ),
    400,
  );
  await assert.rejects(
    pool.query("UPDATE prospect_activities SET body='x' WHERE prospect_id=$1", [
      id,
    ]),
    /Append-only/,
  );
  await assert.rejects(
    pool.query("DELETE FROM prospect_activities WHERE prospect_id=$1", [id]),
    /Append-only/,
  );
});

test("filters and counts: search, stage, owner, follow-ups", async () => {
  const tag = randomUUID().slice(0, 8);
  const past = "2020-01-01";
  const a = await make({ company: `Alpha ${tag}`, next_follow_up_on: past });
  const b = await make({ company: `Beta ${tag}`, owner_id: t.dispatcher });
  await moveProspect(t.dispatcher, b, { stage: "qualified", version: 1 });
  const names = async (q: Record<string, string>) =>
    (
      await listProspects(t.dispatcher, new URLSearchParams({ q: tag, ...q }))
    ).prospects
      .map((p) => p.company)
      .sort();
  assert.deepEqual(await names({}), [`Alpha ${tag}`, `Beta ${tag}`]);
  assert.deepEqual(await names({ stage: "qualified" }), [`Beta ${tag}`]);
  assert.deepEqual(await names({ owner: "me" }), [`Beta ${tag}`]);
  assert.deepEqual(await names({ follow_up: "overdue" }), [`Alpha ${tag}`]);
  // A literal % does not act as a wildcard.
  const wildcard = await listProspects(
    t.dispatcher,
    new URLSearchParams({ q: "%" }),
  );
  assert.equal(wildcard.prospects.length, 0);
  assert.ok((await listProspects(t.dispatcher, none)).follow_ups.overdue >= 1);
  assert.equal(
    await status(
      listProspects(t.dispatcher, new URLSearchParams({ stage: "bogus" })),
    ),
    400,
  );
  void a;
});

test("archiving hides a prospect and keeps its history", async () => {
  const id = await make();
  await logActivity(t.dispatcher, id, {
    kind: "note",
    body: "Not interested yet",
    idempotency_key: randomUUID(),
  });
  assert.equal(
    await status(archiveProspect(t.dispatcher, id, { version: 99 })),
    409,
  );
  await archiveProspect(t.dispatcher, id, { version: 1 });
  assert.equal(await status(getProspect(t.dispatcher, id)), 404);
  assert.ok(
    !(await listProspects(t.dispatcher, none)).prospects.some(
      (p) => p.id === id,
    ),
  );
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM prospect_activities WHERE prospect_id=$1",
    [id],
  );
  assert.equal(rows[0].n, 1);
});

test("converting creates one carrier setup record, books nothing, and is repeatable", async () => {
  const noContact = await make({ contact_name: "", email: "" });
  assert.equal(
    await status(convertProspect(t.dispatcher, noContact, { version: 1 })),
    422,
  );
  const id = await make();
  const first = await convertProspect(t.dispatcher, id, { version: 1 });
  const again = await convertProspect(t.dispatcher, id, { version: 1 });
  assert.equal(first.carrier_id, again.carrier_id);
  const detail = await getProspect(t.dispatcher, id);
  assert.equal(detail.prospect.stage, "won");
  assert.equal(detail.prospect.carrier_id, first.carrier_id);
  assert.equal(detail.activities[0].kind, "converted");
  // The carrier exists in this organization with a setup profile, and has no
  // dispatch authorization until a person verifies one.
  const carrier = await pool.query(
    `SELECT c.organization_id,p.contact_email,p.step,
    (SELECT count(*)::int FROM carrier_dispatch_authorizations a WHERE a.carrier_id=c.id) AS authorizations,
    (SELECT count(*)::int FROM loads l WHERE l.carrier_id=c.id) AS loads
    FROM carriers c JOIN carrier_profiles p ON p.carrier_id=c.id WHERE c.id=$1`,
    [first.carrier_id],
  );
  assert.deepEqual(carrier.rows[0], {
    organization_id: t.organization,
    contact_email: "riley@fictional.test",
    step: "agreement",
    authorizations: 0,
    loads: 0,
  });
  // A prospect that became a carrier cannot be marked lost.
  assert.equal(
    await status(
      moveProspect(t.dispatcher, id, {
        stage: "lost",
        lost_reason: "x",
        version: detail.prospect.version,
      }),
    ),
    409,
  );
  // A lost prospect is not converted.
  const lost = await make();
  await moveProspect(t.dispatcher, lost, {
    stage: "lost",
    lost_reason: "No trucks",
    version: 1,
  });
  assert.equal(
    await status(convertProspect(t.dispatcher, lost, { version: 2 })),
    409,
  );
});

test("HTTP: needs a session, JSON, and returns the same shapes", async () => {
  const anonymous = await GET(request("prospects"));
  assert.equal(anonymous.status, 401);
  const token = await sessionFor(t.dispatcher);
  const created = await POST(
    request("prospects", { token, json: prospect({ company: "HTTP Co" }) }),
  );
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const read = await GET(request("prospects/" + id, { token }));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).prospect.company, "HTTP Co");
  const managerToken = await sessionFor(t.manager);
  const denied = await GET(request("prospects/" + id, { token: managerToken }));
  assert.equal(denied.status, 404);
  const bad = await GET(request("prospects/not-a-uuid", { token }));
  assert.equal(bad.status, 400);
});

test("each change leaves an audit record", async () => {
  const id = await make();
  await updateProspect(t.dispatcher, id, {
    company: "Audited LLC",
    version: 1,
  });
  await moveProspect(t.dispatcher, id, { stage: "contacted", version: 2 });
  const { rows } = await pool.query(
    "SELECT action FROM audit_logs WHERE resource_id=$1 ORDER BY created_at",
    [id],
  );
  assert.deepEqual(
    rows.map((r) => r.action),
    ["prospect.created", "prospect.updated", "prospect.stage_changed"],
  );
});
