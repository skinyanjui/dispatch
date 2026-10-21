import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "./auth";

/**
 * Links a reading to the load a person created from it, inside the create
 * transaction. Someone else's reading, another carrier's, or one already used
 * for a different load is refused, and the load is not created.
 */
export async function linkRead(
  c: PoolClient,
  user: string,
  carrierId: string,
  loadId: string,
  readId: string,
) {
  const { rows } = await c.query(
    "SELECT load_id FROM rate_confirmation_reads WHERE id=$1 AND requested_by=$2 AND carrier_id=$3 AND status='succeeded' FOR UPDATE",
    [readId, user, carrierId],
  );
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND");
  if (rows[0].load_id) throw new HttpError(409, "READ_ALREADY_USED");
  await c.query("UPDATE rate_confirmation_reads SET load_id=$2 WHERE id=$1", [
    readId,
    loadId,
  ]);
  await c.query(
    "INSERT INTO audit_logs VALUES($1,$2,'ai.rate_read.used',$3,now())",
    [randomUUID(), user, readId],
  );
}
