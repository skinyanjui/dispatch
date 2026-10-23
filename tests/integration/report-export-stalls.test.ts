import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import {
  createExport,
  exportStatus,
  runPendingExports,
} from "../../src/lib/report-exports";
import { operationsStatus } from "../../src/lib/operations";
import { tenant } from "./fixtures";

after(() => pool.end());

const input = (from: string) => ({
  from,
  to: "2026-10-31",
  key: randomUUID(),
});
const age = (id: string, minutes: number) =>
  pool.query(
    "UPDATE report_exports SET created_at=now()-make_interval(mins => $2) WHERE id=$1",
    [id, minutes],
  );

test("an export nobody starts is failed with a reason and stops counting toward the limit", async () => {
  const t = await tenant("ExportStall");
  const stuck = [];
  for (const from of ["2026-01-01", "2026-02-01", "2026-03-01"])
    stuck.push(await createExport(t.manager, input(from)));
  // Three waiting jobs is the limit: a fourth request is refused.
  await assert.rejects(createExport(t.manager, input("2026-04-01")), {
    code: "TRY_AGAIN_LATER",
  });

  // A job still inside the window is left alone.
  await age(stuck[0].id, 5);
  await runPendingExports(0);
  assert.equal((await exportStatus(t.manager, stuck[0].id)).status, "queued");

  // Nobody started them in 30 minutes: they fail, with a reason ...
  for (const job of stuck) await age(job.id, 31);
  await runPendingExports(0);
  for (const job of stuck) {
    const status = await exportStatus(t.manager, job.id);
    assert.equal(status.status, "failed");
    assert.equal(status.error_code, "EXPORT_STALLED");
  }
  // ... and the person can ask again.
  const again = await createExport(t.manager, input("2026-04-01"));
  assert.ok(again.id);
});

test("stalled jobs are also failed when the person asks again, without a worker run", async () => {
  const t = await tenant("ExportStallAsk");
  const stuck = [];
  for (const from of ["2026-01-01", "2026-02-01", "2026-03-01"])
    stuck.push(await createExport(t.manager, input(from)));
  for (const job of stuck) await age(job.id, 45);
  // No worker has run: the request itself frees the limit.
  const again = await createExport(t.manager, input("2026-04-01"));
  assert.ok(again.id);
  assert.equal(
    (await exportStatus(t.manager, stuck[1].id)).error_code,
    "EXPORT_STALLED",
  );
});

test("operations status counts exports that wait too long and ones that stalled", async () => {
  const t = await tenant("ExportOps");
  await pool.query(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [t.organization, t.dispatcher],
  );
  const waiting = await createExport(t.manager, input("2026-01-01"));
  await age(waiting.id, 3);
  const before = (await operationsStatus(t.dispatcher)).exports;
  assert.ok(before.waiting >= 1);
  await age(waiting.id, 40);
  await runPendingExports(0);
  const after = (await operationsStatus(t.dispatcher)).exports;
  assert.ok(after.stalled_last_24h >= 1);
});
