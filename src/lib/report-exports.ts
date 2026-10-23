import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, HttpError } from "./auth";
import { pickupRange } from "./reporting-scope";
import { loadsCsv } from "./reports";

async function authorize(
  c: Pick<typeof pool, "query">,
  user: string,
  ids: string[],
) {
  const rows = await c.query(
    "SELECT carrier_id FROM memberships WHERE user_id=$1 AND role<>'driver'",
    [user],
  );
  if (
    !ids.length ||
    ids.some((id) => !rows.rows.some((m) => m.carrier_id === id))
  )
    throw new HttpError(404, "NOT_FOUND");
}
export async function createExport(user: string, input: unknown) {
  const data = z
    .object({
      from: z.iso.date(),
      to: z.iso.date(),
      carrier_id: z.uuid().optional(),
      key: z.uuid(),
    })
    .strict()
    .parse(input);
  const { key, ...filters } = data;
  pickupRange(new URLSearchParams(filters));
  return transaction(async (c) => {
    const carriers = await c.query(
      "SELECT carrier_id FROM memberships WHERE user_id=$1 AND role<>'driver' AND ($2::uuid IS NULL OR carrier_id=$2)",
      [user, data.carrier_id ?? null],
    );
    if (!carriers.rowCount) throw new HttpError(404, "NOT_FOUND");
    const hash = digest(JSON.stringify(filters));
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":export",
    ]);
    const existing = (
      await c.query(
        "SELECT id,request_hash FROM report_exports WHERE user_id=$1 AND idempotency_key=$2",
        [user, key],
      )
    ).rows[0];
    if (existing) {
      if (existing.request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { id: existing.id as string };
    }
    const pending = await c.query(
      "SELECT 1 FROM report_exports WHERE user_id=$1 AND status IN ('queued','running') AND expires_at>now()",
      [user],
    );
    if ((pending.rowCount ?? 0) >= 3)
      throw new HttpError(429, "TRY_AGAIN_LATER");
    const id = randomUUID();
    await c.query(
      "INSERT INTO report_exports(id,user_id,idempotency_key,request_hash,filters,carrier_ids) VALUES($1,$2,$3,$4,$5,$6)",
      [id, user, key, hash, filters, carriers.rows.map((m) => m.carrier_id)],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES(gen_random_uuid(),$1,'report.export_requested',$2,now())",
      [user, id],
    );
    return { id };
  });
}
export async function exportStatus(user: string, id: string, download = false) {
  return transaction(async (c) => {
    const row = (
      await c.query(
        "SELECT id,user_id,carrier_ids,status,filename,row_count,error_code,created_at,finished_at,expires_at,expires_at<=now() expired FROM report_exports WHERE id=$1 AND user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "NOT_FOUND");
    await authorize(c, user, row.carrier_ids);
    if (row.expired) throw new HttpError(410, "EXPORT_EXPIRED");
    if (download) {
      if (row.status !== "ready") throw new HttpError(409, "EXPORT_NOT_READY");
      const artifact = (
        await c.query("SELECT artifact FROM report_exports WHERE id=$1", [id])
      ).rows[0].artifact as Buffer;
      await c.query(
        "INSERT INTO audit_logs VALUES(gen_random_uuid(),$1,'report.export_downloaded',$2,now())",
        [user, id],
      );
      return { ...row, artifact };
    }
    return { ...row, artifact: undefined };
  });
}
/** Durable bounded claims; a crashed worker's lease becomes eligible again. */
export async function runPendingExports(limit = 1) {
  let completed = 0;
  for (let n = 0; n < limit; n++) {
    const job = await transaction(
      async (c) =>
        (
          await c.query(`UPDATE report_exports SET status='running',started_at=now(),error_code=NULL
      WHERE id=(SELECT id FROM report_exports WHERE expires_at>now() AND (status='queued' OR (status='running' AND started_at<now()-interval '5 minutes')) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *,started_at::text lease_at`)
        ).rows[0],
    );
    if (!job) break;
    try {
      await authorize(pool, job.user_id, job.carrier_ids);
      const file = await loadsCsv(
        job.user_id,
        new URLSearchParams(job.filters),
        500000,
      );
      if (Buffer.byteLength(file.csv) > 64 * 1024 * 1024)
        throw new HttpError(422, "EXPORT_RANGE_TOO_LARGE");
      const artifact = await promisify(gzip)(file.csv);
      await pool.query(
        "UPDATE report_exports SET status='ready',filename=$2,row_count=$3,artifact=$4,carrier_ids=$5,finished_at=now() WHERE id=$1 AND status='running' AND started_at=$6",
        [
          job.id,
          file.filename,
          file.row_count,
          artifact,
          file.carrier_ids,
          job.lease_at,
        ],
      );
      completed++;
    } catch (e) {
      await pool.query(
        "UPDATE report_exports SET status='failed',error_code=$2,finished_at=now() WHERE id=$1 AND status='running' AND started_at=$3",
        [
          job.id,
          e instanceof HttpError ? e.code : "SERVICE_UNAVAILABLE",
          job.lease_at,
        ],
      );
      console.error("report.export_failed", {
        id: job.id,
        kind: e instanceof HttpError ? e.code : "SERVICE_UNAVAILABLE",
      });
    }
  }
  await pool.query(
    "UPDATE report_exports SET artifact=NULL WHERE expires_at<=now() AND artifact IS NOT NULL",
  );
  return completed;
}
