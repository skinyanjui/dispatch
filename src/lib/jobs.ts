import { runPendingExports } from "./report-exports";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { HttpError } from "@/lib/auth";
import { deliverDue } from "@/lib/notifications";
import {
  scheduleAppointmentReminders,
  scheduleDailyReminders,
} from "@/lib/notifications";
import { pruneExpiredCredentials } from "./account";
import { sendAlerts } from "./alerts";
import { cleanupAbandoned } from "@/lib/message-attachments";

/**
 * The scheduled notification job (ADR 0046). Two scopes share one endpoint:
 *
 *   tick   every ~15 minutes: appointment reminders (the two-hour tier needs
 *          this) and delivery of queued messages and their retries.
 *   daily  once a day, and the default for a caller that names no scope: the
 *          tick work plus proof-of-delivery, insurance and overdue-exception
 *          reminders, abandoned-upload cleanup and pruning of old run records.
 *
 * Every step is idempotent (dedupe keys, SKIP LOCKED claims), so a repeated or
 * late trigger is harmless; the lock only stops two runs of one scope from
 * piling up.
 */
export const jobScopes = ["tick", "daily"] as const;
export type JobScope = (typeof jobScopes)[number];

export function parseScope(value: string | null): JobScope {
  if (value === null || value === "") return "daily";
  if ((jobScopes as readonly string[]).includes(value))
    return value as JobScope;
  throw new HttpError(400, "VALIDATION_ERROR");
}

type Steps = Record<string, () => Promise<unknown>>;
const defaultSteps = (scope: JobScope): Steps => ({
  appointments: scheduleAppointmentReminders,
  exports: () => runPendingExports(1),
  ...(scope === "daily" ? { reminders: scheduleDailyReminders } : {}),
  delivery: () => deliverDue(50),
  // A broken alert channel must not fail the work above, so it reports itself.
  alerts: () =>
    jobStatus()
      .then(sendAlerts)
      .catch((e) => ({
        error: e instanceof Error ? e.message.slice(0, 100) : "failed",
      })),
  ...(scope === "daily"
    ? {
        cleanup: () => cleanupAbandoned(),
        pruned: pruneJobRuns,
        credentials: pruneExpiredCredentials,
      }
    : {}),
});

export async function pruneJobRuns(days = 30) {
  const r = await pool.query(
    "DELETE FROM job_runs WHERE started_at<now()-make_interval(days=>$1)",
    [days],
  );
  return r.rowCount ?? 0;
}

/** Runs one scope. A second caller while one is running gets `skipped` and
 *  leaves no record. Steps are injectable for tests. */
export async function runNotificationJob(
  scope: JobScope,
  steps: Steps = defaultSteps(scope),
) {
  const client = await pool.connect();
  const key = `job:notifications:${scope}`;
  let locked = false;
  try {
    const got = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",
      [key],
    );
    if (!got.rows[0].ok) return { skipped: "running" as const };
    locked = true;
    const id = randomUUID();
    await client.query(
      "INSERT INTO job_runs(id,job,scope) VALUES($1,'notifications',$2)",
      [id, scope],
    );
    const started = Date.now();
    const detail: Record<string, unknown> = {};
    try {
      for (const [name, step] of Object.entries(steps))
        detail[name] = await step();
      await client.query(
        "UPDATE job_runs SET outcome='ok',finished_at=now(),duration_ms=$2,detail=$3 WHERE id=$1",
        [id, Date.now() - started, JSON.stringify(detail)],
      );
      return detail;
    } catch (e) {
      console.error("job.failed", { job: "notifications", scope });
      await client.query(
        "UPDATE job_runs SET outcome='error',finished_at=now(),duration_ms=$2,detail=$3 WHERE id=$1",
        [
          id,
          Date.now() - started,
          JSON.stringify({
            ...detail,
            error: (e instanceof Error ? e.message : "Job failed").slice(
              0,
              200,
            ),
          }),
        ],
      );
      throw e;
    }
  } finally {
    // Only release a lock this run took; a skipped run never held it.
    if (locked)
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key])
        .catch(() => undefined);
    client.release();
  }
}

/** How late a scope may be before it is called stale. */
const staleAfterMinutes: Record<JobScope, number> = {
  tick: 45,
  daily: 36 * 60,
};
export type JobState = "ok" | "failing" | "stale" | "never";
export type JobStatus = {
  scope: JobScope;
  state: JobState;
  last_run_at: string | null;
  last_success_at: string | null;
  last_outcome: "running" | "ok" | "error" | null;
  last_duration_ms: number | null;
  /** Minutes before a missing run is called stale. */
  stale_after_minutes: number;
};

/** Run times and outcomes only: counts of other organizations' reminders are
 *  not shown. A tick that has never run is "never", not an alarm: the
 *  15-minute trigger is optional until someone configures one. */
export async function jobStatus(): Promise<JobStatus[]> {
  const out: JobStatus[] = [];
  for (const scope of jobScopes) {
    const last = await pool.query(
      `SELECT started_at,outcome,duration_ms FROM job_runs
       WHERE job='notifications' AND scope=$1 ORDER BY started_at DESC LIMIT 1`,
      [scope],
    );
    const ok = await pool.query(
      `SELECT finished_at FROM job_runs
       WHERE job='notifications' AND scope=$1 AND outcome='ok'
       ORDER BY started_at DESC LIMIT 1`,
      [scope],
    );
    const row = last.rows[0];
    const success = ok.rows[0]?.finished_at as Date | undefined;
    const age = success ? (Date.now() - success.getTime()) / 60000 : Infinity;
    const state: JobState = !row
      ? "never"
      : row.outcome === "error"
        ? "failing"
        : age > staleAfterMinutes[scope]
          ? "stale"
          : "ok";
    out.push({
      scope,
      state,
      last_run_at: row ? (row.started_at as Date).toISOString() : null,
      last_success_at: success ? success.toISOString() : null,
      last_outcome: row ? row.outcome : null,
      last_duration_ms: row?.duration_ms ?? null,
      stale_after_minutes: staleAfterMinutes[scope],
    });
  }
  return out;
}

/** Who may read the scheduler status: owners and admins of any organization. */
export async function canSeeJobStatus(user: string) {
  const r = await pool.query(
    "SELECT 1 FROM organization_members WHERE user_id=$1 LIMIT 1",
    [user],
  );
  return !!r.rowCount;
}
