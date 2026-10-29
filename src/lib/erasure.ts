import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { HttpError } from "./auth";
import { emit } from "./onboarding";
import { objectStore } from "./storage";

/**
 * Carrier erasure on request (ADR 0074). The carrier's identity is replaced and
 * personal or sensitive data is removed; financial and audit records stay,
 * because a dispatch company usually has to keep them. What stays is a
 * configuration choice (RELAY_ERASURE_KEEP) within what this tool can erase.
 *
 * Each category lists what it removes. A category that is not erasable here
 * (loads, billing, claims, factoring, audit) is always kept.
 */
export type ErasureCategory = {
  id: string;
  label: string;
  removes: string;
  erasable: boolean;
  /** Kept unless the configuration says otherwise. */
  keptByDefault: boolean;
};
export const erasureCategories: ErasureCategory[] = [
  {
    id: "people",
    label: "People",
    removes:
      "Driver names, emails and phones; vehicle plates and VINs; team memberships and invitations; the carrier's contact person, email and phone.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "contacts",
    label: "Contacts",
    removes: "Contacts and prospects linked to the carrier.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "messages",
    label: "Messages",
    removes: "Message threads about the carrier and their attachments.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "notes",
    label: "Notes",
    removes:
      "Load notes and the free-text notes on check-ins, stop times and corrections.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "documents",
    label: "Documents",
    removes:
      "Uploaded files and their names, scan names, and values read from them by AI.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "lookups",
    label: "Registration lookups",
    removes: "Public-registry lookup history.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "payout",
    label: "Payout details",
    removes:
      "The payout instructions and the names, emails and numbers in change requests.",
    erasable: true,
    keptByDefault: false,
  },
  {
    id: "loads",
    label: "Loads and their history",
    removes: "",
    erasable: false,
    keptByDefault: true,
  },
  {
    id: "billing",
    label: "Invoices and payments",
    removes: "",
    erasable: false,
    keptByDefault: true,
  },
  {
    id: "claims",
    label: "Detention and TONU claims",
    removes: "",
    erasable: false,
    keptByDefault: true,
  },
  {
    id: "factoring",
    label: "Factoring schedules",
    removes: "",
    erasable: false,
    keptByDefault: true,
  },
  {
    id: "audit",
    label: "Audit trail",
    removes: "",
    erasable: false,
    keptByDefault: true,
  },
];

/** Category ids to keep: RELAY_ERASURE_KEEP (comma list), else the defaults. Unknown ids are ignored. */
export function keptCategories(
  env: string | undefined = process.env.RELAY_ERASURE_KEEP,
) {
  const known = new Set(erasureCategories.map((c) => c.id));
  const kept =
    env === undefined
      ? erasureCategories.filter((c) => c.keptByDefault).map((c) => c.id)
      : env
          .split(",")
          .map((s) => s.trim())
          .filter((s) => known.has(s));
  // What this tool cannot erase is always kept.
  for (const c of erasureCategories) if (!c.erasable) kept.push(c.id);
  return new Set(kept);
}

export function erasurePlanFor(kept = keptCategories()) {
  return erasureCategories.map((c) => ({
    id: c.id,
    label: c.label,
    removes: c.removes,
    action: kept.has(c.id) ? ("keep" as const) : ("erase" as const),
  }));
}

/** Work that has to finish first: an erasure must not strand live freight or money. */
export async function erasureBlockers(
  c: Pick<PoolClient, "query">,
  carrierId: string,
) {
  const out: string[] = [];
  const q = async (sql: string) =>
    ((await c.query(sql, [carrierId])).rows[0]?.n as number) > 0;
  if (
    await q(
      "SELECT count(*)::int n FROM loads WHERE carrier_id=$1 AND cancelled_at IS NULL AND stage<>'delivered'",
    )
  )
    out.push("active_loads");
  if (
    await q(
      "SELECT count(*)::int n FROM accessorial_claims WHERE carrier_id=$1 AND status IN ('draft','submitted')",
    )
  )
    out.push("open_claims");
  if (
    await q(
      "SELECT count(*)::int n FROM factoring_batches WHERE carrier_id=$1 AND status='prepared'",
    )
  )
    out.push("prepared_schedules");
  return out;
}

const GONE = "[erased]";

/**
 * Runs the erasure inside the caller's transaction (the approval's). Returns
 * the receipt: what was removed (counts) and what was kept.
 */
export async function eraseCarrier(
  c: PoolClient,
  carrierId: string,
  changeId: string,
  approver: string,
  kept = keptCategories(),
) {
  await c.query("SELECT set_config('relay.erasure','on',true)");
  const counts: Record<string, number> = {};
  const run = async (
    key: string,
    sql: string,
    args: unknown[] = [carrierId],
  ) => {
    const r = await c.query(sql, args);
    counts[key] = (counts[key] ?? 0) + (r.rowCount ?? 0);
  };
  const erase = (id: string) => !kept.has(id);

  if (erase("people")) {
    await run(
      "drivers",
      "UPDATE drivers SET name='Erased driver',contact_email=NULL,phone='' WHERE carrier_id=$1",
    );
    await run(
      "vehicles",
      "UPDATE vehicles SET label='Erased vehicle',plate='',vin='' WHERE carrier_id=$1",
    );
    await run("memberships", "DELETE FROM memberships WHERE carrier_id=$1");
    await run(
      "invitations",
      "DELETE FROM onboarding_invites WHERE carrier_id=$1",
    );
    await run(
      "membership_removals",
      "UPDATE membership_removals SET reason=$2 WHERE carrier_id=$1",
      [carrierId, GONE],
    );
    await run(
      "onboarding_events",
      "UPDATE onboarding_events SET payload='{}'::jsonb WHERE carrier_id=$1",
    );
    await run(
      "profile",
      "UPDATE carrier_profiles SET contact_name='',contact_email='',phone='',usdot='',mc_number='',updated_at=now() WHERE carrier_id=$1",
    );
  }
  if (erase("contacts")) {
    await run(
      "contacts",
      `UPDATE contacts SET name='Erased contact',company='',email='erased@erased.invalid',phone='',notes='',
         sms_consent_note='',archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE carrier_id=$1`,
    );
    await run(
      "prospects",
      `UPDATE prospects SET contact_name='',email='',phone='',notes='',updated_at=now() WHERE carrier_id=$1`,
    );
  }
  if (erase("messages")) {
    await run(
      "messages",
      `UPDATE messages SET body=$2,counterpart='',sender_label='' WHERE thread_id IN (SELECT id FROM threads WHERE carrier_id=$1)`,
      [carrierId, GONE],
    );
    await run("threads", "UPDATE threads SET subject=$2 WHERE carrier_id=$1", [
      carrierId,
      GONE,
    ]);
    await run(
      "attachments",
      `UPDATE message_attachments SET filename='erased'
       WHERE message_id IN (SELECT m.id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.carrier_id=$1)`,
    );
    await purgeObjects(
      c,
      carrierId,
      changeId,
      `SELECT a.storage_key FROM message_attachments a JOIN messages m ON m.id=a.message_id
       JOIN threads t ON t.id=m.thread_id WHERE t.carrier_id=$1`,
      counts,
    );
  }
  if (erase("notes")) {
    await run(
      "load_notes",
      "UPDATE load_notes SET body=$2 WHERE carrier_id=$1",
      [carrierId, GONE],
    );
    await run("check_ins", "UPDATE check_ins SET note='' WHERE carrier_id=$1");
    await run(
      "check_in_amendments",
      "UPDATE check_in_amendments SET note=CASE WHEN note IS NULL THEN NULL ELSE '' END,reason=$2 WHERE carrier_id=$1",
      [carrierId, GONE],
    );
    await run(
      "stop_events",
      "UPDATE stop_events SET note='' WHERE carrier_id=$1",
    );
  }
  if (erase("documents")) {
    await run(
      "document_versions",
      "UPDATE document_versions SET filename='erased' WHERE carrier_id=$1",
    );
    await run(
      "document_scans",
      "UPDATE document_scans SET filename='erased' WHERE carrier_id=$1",
    );
    await run(
      "extractions",
      "UPDATE document_extractions SET fields=CASE WHEN fields IS NULL THEN NULL ELSE '{}'::jsonb END,checked_fields=NULL WHERE carrier_id=$1",
    );
    await run(
      "rate_reads",
      "UPDATE rate_confirmation_reads SET fields=CASE WHEN fields IS NULL THEN NULL ELSE '{}'::jsonb END,filename='erased' WHERE carrier_id=$1",
    );
    await purgeObjects(
      c,
      carrierId,
      changeId,
      "SELECT storage_key FROM document_versions WHERE carrier_id=$1",
      counts,
    );
  }
  if (erase("lookups"))
    await run(
      "lookups",
      "DELETE FROM carrier_authority_checks WHERE carrier_id=$1",
    );
  if (erase("payout")) {
    await run(
      "payout_details",
      "DELETE FROM carrier_payout_details WHERE carrier_id=$1",
    );
    // This request keeps its own row; the receipt replaces its text below.
    await run(
      "change_requests",
      `UPDATE sensitive_changes SET summary=$2,current_value='{}'::jsonb,proposed_value='{}'::jsonb
       WHERE carrier_id=$1 AND id<>$3 AND kind<>'carrier_erasure'`,
      [carrierId, "Change request (details erased)", changeId],
    );
  }
  // Other pending requests for the carrier are moot.
  await c.query(
    `UPDATE sensitive_changes SET status='cancelled',decided_by=requested_by,decided_at=now(),decision_note='Carrier erased'
     WHERE carrier_id=$1 AND status='pending' AND id<>$2`,
    [carrierId, changeId],
  );
  // The carrier can no longer be booked against, and its identity is gone.
  await c.query(
    `UPDATE carrier_dispatch_authorizations SET expires_at=GREATEST(effective_at+interval '1 second',LEAST(expires_at,now()))
     WHERE carrier_id=$1`,
    [carrierId],
  );
  await c.query(
    "UPDATE carriers SET name='Erased carrier '||left(id::text,8),erased_at=now() WHERE id=$1",
    [carrierId],
  );
  const receipt = {
    erased_at: new Date().toISOString(),
    erased: erasurePlanFor(kept)
      .filter((p) => p.action === "erase")
      .map((p) => p.id),
    kept: erasurePlanFor(kept)
      .filter((p) => p.action === "keep")
      .map((p) => p.id),
    counts,
  };
  await c.query(
    `UPDATE sensitive_changes SET summary='Carrier erased',current_value='{}'::jsonb,proposed_value=$2 WHERE id=$1`,
    [changeId, JSON.stringify(receipt)],
  );
  await emit(c, approver, carrierId, "carrier.erased", {
    change_id: changeId,
    erased: receipt.erased,
    kept: receipt.kept,
    counts,
  });
  return receipt;
}

/**
 * Empties stored files: bytes held in the database are cleared at once; files
 * in a bucket are queued for deletion (retried by the job until confirmed).
 */
async function purgeObjects(
  c: PoolClient,
  carrierId: string,
  changeId: string,
  keysSql: string,
  counts: Record<string, number>,
) {
  const keys = (await c.query(keysSql, [carrierId])).rows.map(
    (r) => r.storage_key as string,
  );
  if (!keys.length) return;
  const cleared = await c.query(
    `UPDATE document_objects SET content='\\x'::bytea,purged_at=now()
     WHERE storage_key=ANY($1) AND backend='postgres' AND purged_at IS NULL`,
    [keys],
  );
  counts.files_cleared = (counts.files_cleared ?? 0) + (cleared.rowCount ?? 0);
  const queued = await c.query(
    `INSERT INTO erasure_object_deletions(storage_key,carrier_id,change_id)
     SELECT storage_key,$2,$3 FROM document_objects WHERE storage_key=ANY($1) AND backend='s3' AND purged_at IS NULL
     ON CONFLICT DO NOTHING`,
    [keys, carrierId, changeId],
  );
  counts.files_queued = (counts.files_queued ?? 0) + (queued.rowCount ?? 0);
}

/** Deletes queued bucket objects; each is independent and retried next run. */
export async function runObjectPurges(limit = 50) {
  const due = await pool.query(
    "SELECT storage_key FROM erasure_object_deletions WHERE done_at IS NULL ORDER BY created_at LIMIT $1",
    [limit],
  );
  const out = { deleted: 0, failed: 0 };
  const bucket = objectStore();
  for (const row of due.rows) {
    try {
      if (!bucket) throw new Error("No object store configured");
      await bucket.delete(row.storage_key);
      await transaction(async (c) => {
        await c.query("SELECT set_config('relay.erasure','on',true)");
        await c.query(
          "UPDATE document_objects SET purged_at=now() WHERE storage_key=$1 AND purged_at IS NULL",
          [row.storage_key],
        );
        await c.query(
          "UPDATE erasure_object_deletions SET done_at=now() WHERE storage_key=$1",
          [row.storage_key],
        );
        await c.query("INSERT INTO audit_logs VALUES($1,NULL,$2,$3,now())", [
          randomUUID(),
          "erasure.object_deleted",
          row.storage_key,
        ]);
      });
      out.deleted++;
    } catch (e) {
      out.failed++;
      await pool.query(
        "UPDATE erasure_object_deletions SET attempts=attempts+1,last_error=$2 WHERE storage_key=$1",
        [
          row.storage_key,
          (e instanceof Error ? e.message : "failed").slice(0, 200),
        ],
      );
    }
  }
  return out;
}

/** The plan and blockers for a carrier, for the screen. */
export async function erasureOverview(carrierId: string) {
  const carrier = await pool.query(
    "SELECT erased_at FROM carriers WHERE id=$1",
    [carrierId],
  );
  if (!carrier.rows[0]) throw new HttpError(404, "NOT_FOUND");
  return {
    erased: !!carrier.rows[0].erased_at,
    plan: erasurePlanFor(),
    blockers: await erasureBlockers(pool, carrierId),
    pending_files: (
      await pool.query(
        "SELECT count(*)::int n FROM erasure_object_deletions WHERE carrier_id=$1 AND done_at IS NULL",
        [carrierId],
      )
    ).rows[0].n as number,
  };
}
