import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePath,
  pathFor,
  sectionAllowed,
  workspaceSections,
  type Route,
} from "../../src/lib/routes";

const id = "3f2a9c1e-7b64-4d3a-9a51-0c8e2f6b7d10";
const split = (p: string) => p.split("/").filter(Boolean);

test("every address round-trips through parsePath and pathFor", () => {
  const routes: Route[] = [
    ...workspaceSections.map((section) => ({ section })),
    { section: "loads", loadId: id },
    { section: "billing", invoiceId: id },
    { section: "carriers", carrierId: id, carrierPanel: "setup" },
    { section: "carriers", carrierId: id, carrierPanel: "documents" },
  ];
  for (const r of routes) {
    const path = pathFor(r);
    assert.deepEqual(parsePath(split(path)), r, path);
  }
});

test("the home address is Loads and /loads is an alias for it", () => {
  assert.deepEqual(parsePath([]), { section: "loads" });
  assert.deepEqual(parsePath(["loads"]), { section: "loads" });
  assert.equal(pathFor({ section: "loads" }), "/");
});

test("ids are matched case-insensitively and normalized to lower case", () => {
  assert.deepEqual(parsePath(["loads", id.toUpperCase()]), {
    section: "loads",
    loadId: id,
  });
});

test("anything that names nothing is not a page", () => {
  for (const bad of [
    ["nope"],
    ["loads", "not-a-uuid"],
    ["loads", id, "extra"],
    ["billing", "invoices"],
    ["billing", "invoices", "x"],
    ["billing", id],
    ["carriers", "x"],
    ["carriers", id, "nope"],
    ["carriers", id, "documents", "x"],
    ["account", "x"],
    ["api"],
    ["demo"],
    [".."],
    ["loads", `${id}%00`],
  ])
    assert.equal(parsePath(bad), null, bad.join("/"));
});

type Who = Parameters<typeof sectionAllowed>[1];
const driver: Who = { carriers: [{ role: "driver" }], organizations: [] };
const manager: Who = {
  carriers: [{ role: "carrier-manager" }],
  organizations: [],
};
const dispatcher: Who = {
  carriers: [{ role: "dispatcher" }],
  organizations: [],
};
const admin: Who = {
  carriers: [{ role: "dispatcher" }],
  organizations: [{ role: "owner" }],
};

test("pages are offered by role, the same rule the sidebar uses", () => {
  const open = (who: Who) =>
    workspaceSections.filter((s) => sectionAllowed(s, who));
  assert.deepEqual(open(driver), [
    "loads",
    "exceptions",
    "notifications",
    "account",
    "contacts",
    "inbox",
  ]);
  assert.ok(!open(manager).includes("prospects"));
  assert.ok(open(manager).includes("billing"));
  assert.ok(open(dispatcher).includes("prospects"));
  assert.ok(!open(dispatcher).includes("organization"));
  assert.ok(open(admin).includes("organization"));
  assert.ok(open(admin).includes("audit"));
  assert.ok(!open(dispatcher).includes("audit"));
  assert.ok(!open(manager).includes("audit"));
});
