import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Every error code the money-control modules can answer with has a plain-words
 * message in client-api.ts, so people never see "Something didn't go as
 * planned" for a rule the product enforces on purpose (audit 2026-10-29, item 10).
 */
const modules = [
  "authority",
  "authority-state",
  "billing-cash",
  "change-control",
  "claims",
  "factoring",
  "readiness",
];
const messages = new Set(
  [
    ...readFileSync("src/lib/client-api.ts", "utf8").matchAll(
      /^  ([A-Z][A-Z0-9_]+):/gm,
    ),
  ].map((m) => m[1]),
);
test("every code the money-control modules throw has a friendly message", () => {
  const missing: string[] = [];
  for (const name of modules) {
    const source = readFileSync(`src/lib/${name}.ts`, "utf8");
    for (const m of source.matchAll(/\b[2345]\d\d,\s*"([A-Z][A-Z0-9_]+)"/g))
      if (!messages.has(m[1])) missing.push(`${name}: ${m[1]}`);
  }
  // Codes thrown by the shared handlers these modules call.
  for (const code of [
    "REASON_REQUIRED",
    "INVALID_MFA_CODE",
    "IDEMPOTENCY_CONFLICT",
  ])
    if (!messages.has(code)) missing.push("shared: " + code);
  assert.deepEqual(missing, []);
});
