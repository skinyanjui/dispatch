import test from "node:test";
import assert from "node:assert/strict";
import {
  fade,
  minimumVisits,
  mostUsedSection,
  recordVisit,
} from "../../src/lib/most-used";

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};
const everything = () => true;

test("until there is a habit, the logo goes to Loads", () => {
  const store = memory();
  assert.equal(mostUsedSection(store, "u", everything), "loads");
  for (let i = 0; i < minimumVisits - 1; i++) recordVisit(store, "u", "inbox");
  assert.equal(mostUsedSection(store, "u", everything), "loads");
  recordVisit(store, "u", "inbox");
  assert.equal(mostUsedSection(store, "u", everything), "inbox");
});

test("the most used page wins, and a new habit overtakes an old one", () => {
  const store = memory();
  for (let i = 0; i < 10; i++) recordVisit(store, "u", "billing");
  assert.equal(mostUsedSection(store, "u", everything), "billing");
  // Visits fade by `fade` each time, so steady new use overtakes the old.
  let switched = 0;
  for (let i = 1; i <= 80; i++) {
    recordVisit(store, "u", "exceptions");
    if (!switched && mostUsedSection(store, "u", everything) === "exceptions")
      switched = i;
  }
  assert.ok(switched > 0 && switched < 30, `switched after ${switched} visits`);
  assert.ok(fade < 1 && fade > 0.8);
});

test("pages the person cannot open, and utilities, never win", () => {
  const store = memory();
  for (let i = 0; i < 8; i++) recordVisit(store, "u", "billing");
  for (let i = 0; i < 20; i++) recordVisit(store, "u", "account");
  assert.equal(mostUsedSection(store, "u", everything), "billing");
  // A driver's habit of opening a page they lost access to falls back to Loads.
  assert.equal(
    mostUsedSection(store, "u", (s) => s !== "billing"),
    "loads",
  );
});

test("people do not share a tally, and unreadable or missing storage is harmless", () => {
  const store = memory();
  for (let i = 0; i < 5; i++) recordVisit(store, "a", "inbox");
  assert.equal(mostUsedSection(store, "b", everything), "loads");
  store.setItem("relay-page-visits:a", "not json");
  assert.equal(mostUsedSection(store, "a", everything), "loads");
  assert.equal(mostUsedSection(null, "a", everything), "loads");
  recordVisit(null, "a", "inbox");
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.doesNotThrow(() => recordVisit(broken, "a", "inbox"));
});
