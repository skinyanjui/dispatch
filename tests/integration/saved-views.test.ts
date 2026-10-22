import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { GET, POST } from "../../src/app/api/[...path]/route";
import { request, sessionFor, tenant } from "./fixtures";

after(() => pool.end());
let t: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
const config = (over: Record<string, unknown> = {}) => ({
  layout: "table",
  group_by: "stage",
  sort: { key: "freight", desc: true },
  hidden_fields: ["created"],
  compact: false,
  calendar_field: "next",
  filters: { status: "", carrier_id: null },
  ...over,
});
before(async () => {
  t = await tenant("Views");
  other = await tenant("ViewsOther");
  // The dispatcher and the manager belong to one organization; a stranger to another.
  for (const [org, user, role] of [
    [t.organization, t.dispatcher, "owner"],
    [t.organization, t.manager, "admin"],
    [other.organization, other.dispatcher, "owner"],
  ])
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
      [org, user, role],
    );
});
const post = async (user: string, path: string, json: unknown) =>
  POST(request(path, { token: await sessionFor(user), json }));
const list = async (user: string) =>
  (
    await (
      await GET(request("views", { token: await sessionFor(user) }))
    ).json()
  ).views as { id: string; name: string; shared: boolean; mine: boolean }[];

test("a private view is only the owner's; a shared view reaches the organization", async () => {
  const name = "Mine " + randomUUID().slice(0, 6);
  const priv = await post(t.dispatcher, "views", { name, config: config() });
  assert.equal(priv.status, 201);
  const pub = await post(t.dispatcher, "views", {
    name: "Shared " + name,
    shared: true,
    config: config({ layout: "calendar" }),
  });
  assert.equal(pub.status, 201);
  const seenByManager = await list(t.manager);
  assert.ok(seenByManager.some((v) => v.name === "Shared " + name && !v.mine));
  assert.ok(!seenByManager.some((v) => v.name === name));
  const seenByStranger = await list(other.dispatcher);
  assert.ok(!seenByStranger.some((v) => v.name.includes(name)));
  assert.ok((await list(t.dispatcher)).filter((v) => v.mine).length >= 2);
});

test("only the owner can change or delete a view; others and strangers get 404", async () => {
  const made = await post(t.dispatcher, "views", {
    name: "Locked " + randomUUID().slice(0, 6),
    shared: true,
    config: config(),
  });
  const { id } = await made.json();
  for (const user of [t.manager, other.dispatcher]) {
    assert.equal(
      (await post(user, `views/${id}`, { name: "Hijack" })).status,
      404,
    );
    assert.equal((await post(user, `views/${id}/delete`, {})).status, 404);
  }
  assert.equal(
    (
      await post(t.dispatcher, `views/${id}`, {
        name: "Renamed " + id.slice(0, 4),
      })
    ).status,
    200,
  );
  assert.equal(
    (await post(t.dispatcher, `views/${id}`, { shared: false })).status,
    200,
  );
  assert.ok(!(await list(t.manager)).some((v) => v.id === id)); // unshared
  assert.equal(
    (await post(t.dispatcher, `views/${id}/delete`, {})).status,
    200,
  );
  assert.equal(
    (await post(t.dispatcher, `views/${id}/delete`, {})).status,
    404,
  );
});

test("names are unique per owner, config is validated, and sharing needs an organization", async () => {
  const name = "Dup " + randomUUID().slice(0, 6);
  assert.equal(
    (await post(t.dispatcher, "views", { name, config: config() })).status,
    201,
  );
  assert.equal(
    (await post(t.dispatcher, "views", { name, config: config() })).status,
    409,
  );
  // Another person may reuse the name.
  assert.equal(
    (await post(t.manager, "views", { name, config: config() })).status,
    201,
  );
  for (const bad of [
    config({ layout: "map" }),
    config({ hidden_fields: ["secret"] }),
    config({ filters: { status: "", carrier_id: "not-a-uuid" } }),
    { ...config(), extra: true },
  ])
    assert.equal(
      (await post(t.dispatcher, "views", { name: "Bad", config: bad })).status,
      400,
    );
  assert.equal(
    (await post(t.dispatcher, "views", { name: "", config: config() })).status,
    400,
  );
  // The driver belongs to no organization, so cannot share.
  assert.equal(
    (
      await post(t.driverUser, "views", {
        name: "Drv",
        shared: true,
        config: config(),
      })
    ).status,
    422,
  );
  assert.equal(
    (await post(t.driverUser, "views", { name: "Drv", config: config() }))
      .status,
    201,
  );
  assert.equal((await GET(request("views"))).status, 401);
});
