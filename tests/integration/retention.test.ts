import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/lib/db";
import { batchFile } from "../../src/lib/factoring";
import { retentionYears, runRetention } from "../../src/lib/retention";
import { tenant } from "./fixtures";

let t: Awaited<ReturnType<typeof tenant>>;
before(async () => {
  t = await tenant("Retention");
});
after(() => pool.end());

async function batchAt(age: string, status = "handed_off") {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO factoring_batches(id,carrier_id,factor_name,status,load_count,total_minor,file_sha256,file_csv,created_by,created_at,
       handed_off_at,voided_at,idempotency_key,request_hash)
     VALUES($1,$2,'Fictional Factor Co',$3,1,100,$4,'a,b\n1,2',$5,now()-$6::interval,
       CASE WHEN $3='handed_off' THEN now() END, CASE WHEN $3='void' THEN now() END,$7,'x')`,
    [id, t.carrier, status, "a".repeat(64), t.manager, age, randomUUID()],
  );
  return id;
}
const lookup = (carrier: string, age: string, outcome = "ok") =>
  pool.query(
    `INSERT INTO carrier_authority_checks(id,carrier_id,usdot,source,outcome,observed_at,created_at,error_code)
     VALUES($1,$2,'1000001','fixture',$3,now(),now()-$4::interval,$5)`,
    [
      randomUUID(),
      carrier,
      outcome,
      age,
      outcome === "error" ? "TIMEOUT" : null,
    ],
  );

test("the period defaults to seven years and is never shorter than one", () => {
  delete process.env.RELAY_RETENTION_YEARS;
  assert.equal(retentionYears(), 7);
  process.env.RELAY_RETENTION_YEARS = "0";
  assert.equal(retentionYears(), 7);
  process.env.RELAY_RETENTION_YEARS = "10";
  assert.equal(retentionYears(), 10);
  delete process.env.RELAY_RETENTION_YEARS;
});

test("an old schedule file is removed with its hash kept; a recent or prepared one stays", async () => {
  const old = await batchAt("8 years");
  const oldVoid = await batchAt("9 years", "void");
  const recent = await batchAt("1 year");
  const result = await runRetention(7);
  assert.ok(result.factoring_files >= 2);
  const rows = (
    await pool.query(
      "SELECT id,file_csv,file_purged_at,file_sha256 FROM factoring_batches WHERE id=ANY($1)",
      [[old, oldVoid, recent]],
    )
  ).rows;
  const by = (id: string) => rows.find((r) => r.id === id);
  assert.equal(by(old).file_csv, null);
  assert.ok(by(old).file_purged_at);
  assert.equal(by(old).file_sha256, "a".repeat(64));
  assert.equal(by(oldVoid).file_csv, null);
  assert.equal(by(recent).file_csv, "a,b\n1,2");
  await assert.rejects(batchFile(t.manager, old), { code: "FILE_PURGED" });
  assert.equal((await batchFile(t.manager, recent)).csv, "a,b\n1,2");
  const audit = await pool.query(
    "SELECT 1 FROM audit_logs WHERE action='retention.factoring_file_purged' AND resource_id=$1",
    [old],
  );
  assert.equal(audit.rowCount, 1);
  // A second run has nothing more to do for these.
  const again = await pool.query(
    "SELECT count(*)::int n FROM audit_logs WHERE action='retention.factoring_file_purged' AND resource_id=$1",
    [old],
  );
  await runRetention(7);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_logs WHERE action='retention.factoring_file_purged' AND resource_id=$1",
        [old],
      )
    ).rows[0].n,
    again.rows[0].n,
  );
});

test("old lookups go but each carrier keeps its newest lookup and newest success; others cannot be deleted", async () => {
  const carrier = t.carrier;
  await pool.query("DELETE FROM carrier_authority_checks WHERE false");
  await lookup(carrier, "9 years");
  await lookup(carrier, "8 years", "error");
  await lookup(carrier, "8 years", "ok"); // newest success: kept
  await lookup(carrier, "1 day", "error"); // newest lookup: kept
  const before = (
    await pool.query(
      "SELECT count(*)::int n FROM carrier_authority_checks WHERE carrier_id=$1",
      [carrier],
    )
  ).rows[0].n;
  const result = await runRetention(7);
  assert.ok(result.authority_checks >= 2);
  const after = (
    await pool.query(
      "SELECT outcome,created_at<now()-interval '7 years' old FROM carrier_authority_checks WHERE carrier_id=$1",
      [carrier],
    )
  ).rows;
  assert.equal(after.length, before - 2);
  assert.ok(after.some((r) => r.old && r.outcome === "ok"));
  // Outside the job, rows stay append-only.
  await assert.rejects(
    pool.query("DELETE FROM carrier_authority_checks WHERE carrier_id=$1", [
      carrier,
    ]),
    /Append-only/,
  );
  await assert.rejects(
    pool.query(
      "UPDATE carrier_authority_checks SET legal_name='x' WHERE carrier_id=$1",
      [carrier],
    ),
    /Append-only/,
  );
});
