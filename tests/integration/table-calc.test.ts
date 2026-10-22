import test from "node:test";
import assert from "node:assert/strict";
import { calcColumn } from "../../src/components/loads-views";
import type { Load } from "../../src/lib/contracts";

const load = (over: Partial<Load>, driver?: string, accepted = 0): Load =>
  ({
    id: over.reference ?? "x",
    reference: "L",
    carrier_id: "c",
    stage: "booked",
    amount_minor: "100",
    created_at: "2026-01-02T12:00:00Z",
    summary: {
      driver_name: driver ?? null,
      docs: { accepted },
      next: null,
    },
    ...over,
  }) as unknown as Load;

const loads = [
  load({ carrier_name: "Acme", amount_minor: "100" }, "Dee", 1),
  load(
    { carrier_name: "Acme", created_at: "2026-01-05T12:00:00Z" },
    undefined,
    2,
  ),
  load({ carrier_name: "", stage: "delivered" }, "Dee", 4),
];

test("text columns count filled, empty and unique values", () => {
  assert.equal(calcColumn(loads, "carrier", "filled"), "2");
  assert.equal(calcColumn(loads, "carrier", "empty"), "1");
  assert.equal(calcColumn(loads, "carrier", "unique"), "1");
  assert.equal(calcColumn(loads, "driver", "filled"), "2");
  assert.equal(calcColumn(loads, "stage", "unique"), "2");
});

test("created gives earliest and latest dates", () => {
  assert.equal(calcColumn(loads, "created", "earliest"), "Jan 2");
  assert.equal(calcColumn(loads, "created", "latest"), "Jan 5");
});

test("documents aggregate accepted out of required, average half up", () => {
  assert.match(calcColumn(loads, "docs", "sum"), /^7\/\d+$/);
  assert.match(calcColumn(loads, "docs", "min"), /^1\//);
  assert.match(calcColumn(loads, "docs", "max"), /^4\//);
  assert.match(calcColumn(loads, "docs", "average"), /^2\.3\//);
});

test("freight stays in integer minor units and unsupported picks are blank", () => {
  assert.equal(calcColumn(loads, "freight", "sum"), "$3.00");
  assert.equal(calcColumn(loads, "carrier", "sum"), "");
  assert.equal(calcColumn([], "freight", "sum"), "");
});
