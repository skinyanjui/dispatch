import type { Pool, PoolClient } from "pg";
import {
  documentStatus,
  loadDocumentTypes,
  todayUtc,
  type DocumentStatus,
  type LoadDocumentType,
} from "./compliance";
import { effective, type StopEvent } from "./stop-timing";
import { summarize, type LoadSummary } from "./attention";

type Db = Pool | PoolClient;

/**
 * Attaches each load's answers (driver, next stop, paperwork, exceptions and
 * what needs attention) using four queries for the whole page, so the board
 * can answer without opening anything (ADR 0029). Callers pass loads the
 * viewer is already allowed to see; nothing here widens access.
 */
export async function withSummaries<
  T extends { id: string; stage: string; cancelled_at?: string | null },
>(
  db: Db,
  loads: T[],
  now = Date.now(),
): Promise<(T & { summary: LoadSummary })[]> {
  if (!loads.length) return [];
  const ids = loads.map((l) => l.id);
  const [stops, events, drivers, docs, exceptions] = await Promise.all([
    db.query(
      "SELECT id,load_id,kind,address,window_start,window_end,timezone FROM load_stops WHERE load_id=ANY($1) ORDER BY load_id,sequence",
      [ids],
    ),
    db.query(
      "SELECT id,stop_id,load_id,kind,occurred_at,supersedes FROM stop_events WHERE load_id=ANY($1) ORDER BY recorded_at,id",
      [ids],
    ),
    db.query(
      "SELECT a.load_id,d.name FROM load_assignments a JOIN drivers d ON d.id=a.driver_id WHERE a.load_id=ANY($1)",
      [ids],
    ),
    db.query(
      `SELECT DISTINCT ON (d.load_id,d.type) d.load_id,d.type,to_char(v.expires_on,'YYYY-MM-DD') expires_on,
        (SELECT r.decision FROM document_reviews r WHERE r.version_id=v.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) decision
      FROM documents d JOIN document_versions v ON v.document_id=d.id
      WHERE d.load_id=ANY($1) ORDER BY d.load_id,d.type,v.version DESC`,
      [ids],
    ),
    db.query(
      "SELECT load_id,due_at FROM load_exceptions WHERE load_id=ANY($1) AND status<>'resolved'",
      [ids],
    ),
  ]);
  const today = todayUtc();
  return loads.map((load) => {
    const history = (stopId: string) =>
      events.rows.filter((e) => e.stop_id === stopId) as unknown as StopEvent[];
    const docStatus = Object.fromEntries(
      loadDocumentTypes.map((type) => {
        const row = docs.rows.find(
          (d) => d.load_id === load.id && d.type === type,
        );
        return [
          type,
          row
            ? documentStatus(
                {
                  expires_on: row.expires_on,
                  review: row.decision
                    ? {
                        decision: row.decision,
                        note: "",
                        reviewer_name: "",
                        created_at: "",
                      }
                    : null,
                },
                today,
              )
            : "missing",
        ];
      }),
    ) as Record<LoadDocumentType, DocumentStatus>;
    const summary = summarize(
      {
        stage: load.stage,
        cancelled: Boolean(load.cancelled_at),
        driver_name:
          drivers.rows.find((d) => d.load_id === load.id)?.name ?? null,
        stops: stops.rows
          .filter((s) => s.load_id === load.id)
          .map((s) => ({
            kind: s.kind,
            address: s.address,
            window_start: new Date(s.window_start).toISOString(),
            window_end: new Date(s.window_end).toISOString(),
            timezone: s.timezone,
            arrived: effective(history(s.id), "arrived"),
            departed: effective(history(s.id), "departed"),
          })),
        docs: docStatus,
        exceptions: exceptions.rows
          .filter((e) => e.load_id === load.id)
          .map((e) => ({
            due_at: e.due_at ? new Date(e.due_at).toISOString() : null,
          })),
      },
      now,
    );
    return { ...load, summary };
  });
}
