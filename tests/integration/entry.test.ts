import test from "node:test";
import assert from "node:assert/strict";
import {
  dollarsToMinor,
  appointmentToInstant,
  formatMoney,
} from "../../src/lib/entry";
test("USD entry preserves cents and rejects rounding and exponent notation", () => {
  assert.equal(dollarsToMinor("2500.01"), 250001);
  assert.equal(dollarsToMinor("0.29"), 29);
  assert.equal(dollarsToMinor("90071992547409.91"), Number.MAX_SAFE_INTEGER);
  for (const v of ["-1", "1.999", "1e3", "90071992547409.92"])
    assert.throws(() => dollarsToMinor(v));
  assert.equal(formatMoney("9007199254740991"), "$90,071,992,547,409.91");
});
test("appointments use the stop zone and reject ambiguous or nonexistent local times", () => {
  assert.equal(
    appointmentToInstant("2026-11-05T09:00", "America/Chicago"),
    "2026-11-05T15:00:00Z",
  );
  assert.equal(
    appointmentToInstant("2026-11-05T09:00", "America/New_York"),
    "2026-11-05T14:00:00Z",
  );
  assert.throws(() =>
    appointmentToInstant("2026-03-08T02:30", "America/Chicago"),
  );
  assert.throws(() =>
    appointmentToInstant("2026-11-01T01:30", "America/Chicago"),
  );
});
