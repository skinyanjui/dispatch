import { randomUUID } from "node:crypto";
import { transaction } from "./db";

/**
 * Retention (ADR 0073). Two kinds of record are let go after a period, the
 * first of them chosen by RELAY_RETENTION_YEARS (default 7, at least 1):
 * the CSV file of a handed-off or cancelled factoring schedule (its hash, count
 * and total stay) and registration lookups older than the period, except the
 * newest lookup of each carrier and its newest successful one. Claim evidence,
 * invoices, events and audit rows are not touched. Each purge writes an audit
 * row, and a run reports counts so a quiet job is visible.
 */
export function retentionYears() {
  const n = Number(process.env.RELAY_RETENTION_YEARS ?? 7);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
}

export async function runRetention(years = retentionYears()) {
  const files = await transaction(async (c) => {
    const due = await c.query(
      `UPDATE factoring_batches SET file_csv=NULL,file_purged_at=now()
       WHERE file_csv IS NOT NULL AND status IN ('handed_off','void')
         AND created_at<now()-make_interval(years=>$1)
       RETURNING id`,
      [years],
    );
    for (const r of due.rows)
      await c.query(
        "INSERT INTO audit_logs(id,actor_id,action,resource_id) VALUES($1,NULL,'retention.factoring_file_purged',$2)",
        [randomUUID(), r.id],
      );
    return due.rowCount ?? 0;
  });
  const lookups = await transaction(async (c) => {
    await c.query("SELECT set_config('relay.retention','on',true)");
    const gone = await c.query(
      `DELETE FROM carrier_authority_checks k
       WHERE k.created_at<now()-make_interval(years=>$1)
         AND k.id NOT IN (
           SELECT DISTINCT ON (carrier_id) id FROM carrier_authority_checks ORDER BY carrier_id,created_at DESC,id DESC)
         AND k.id NOT IN (
           SELECT DISTINCT ON (carrier_id) id FROM carrier_authority_checks WHERE outcome='ok' ORDER BY carrier_id,created_at DESC,id DESC)
       RETURNING carrier_id`,
      [years],
    );
    const per = new Map<string, number>();
    for (const r of gone.rows)
      per.set(r.carrier_id, (per.get(r.carrier_id) ?? 0) + 1);
    for (const carrier of per.keys())
      await c.query(
        "INSERT INTO audit_logs(id,actor_id,action,resource_id) VALUES($1,NULL,'retention.authority_checks_pruned',$2)",
        [randomUUID(), carrier],
      );
    return gone.rowCount ?? 0;
  });
  return { years, factoring_files: files, authority_checks: lookups };
}
