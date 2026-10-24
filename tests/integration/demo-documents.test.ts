import test from "node:test";
import assert from "node:assert/strict";
import { seedDocuments } from "../../src/lib/demo-documents";
import { mergeFields, allFields, unknownFields } from "../../src/lib/drafts";

const loads = ["booked", "dispatched", "picked-up", "delivered"].map(
  (stage, i) => ({
    reference: "RL-10" + i,
    carrier_name: "Fictional Carrier",
    stage,
    pickup: "Chicago, IL",
    delivery: "Nashville, TN",
    amount_minor: "250000",
    assignment: i % 2 ? { name: "Jordan Ellis" } : null,
  }),
);

test("the demo's templates use only fields the server offers, and drafts say what is missing", () => {
  const docs = seedDocuments(loads);
  for (const t of docs.templates)
    assert.deepEqual(
      unknownFields(t.target, t.body),
      [],
      `${t.name} uses an unknown merge field`,
    );
  assert.ok(docs.drafts.length >= 3);
  // A load with no driver leaves the field visibly missing, never invented.
  const unassigned = docs.drafts.find((d) => d.target_label === "RL-100")!;
  assert.ok(unassigned.missing.includes("load.driver"));
  assert.match(unassigned.body, /\[missing: load\.driver\]/);
  assert.ok(
    docs.drafts.every(
      (d) => d.status in { draft: 1, approved: 1, discarded: 1 },
    ),
  );
});

test("merge fields are one list for the server, the demo and the browser", () => {
  assert.deepEqual(
    Object.keys(allFields("load")).slice(0, 2),
    Object.keys(mergeFields.load).slice(0, 2),
  );
  assert.ok("sender.name" in allFields("contact"));
});
