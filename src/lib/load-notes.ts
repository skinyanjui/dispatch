import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { HttpError, digest } from "./auth";
import { member, scoped } from "./loads";

export const noteSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    idempotency_key: z.uuid().transform((v) => v.toLowerCase()),
  })
  .strict();

/** Notes are staff-only: a driver gets the same 404 as for a foreign load. */
async function staffOnly(
  c: Parameters<typeof scoped>[0],
  user: string,
  id: string,
  write: boolean,
) {
  const load = await scoped(c, user, id, write);
  const m = await member(c, user, load.carrier_id);
  if (m.role === "driver") throw new HttpError(404, "NOT_FOUND");
  return load;
}

export async function listNotes(user: string, id: string) {
  return transaction(async (c) => {
    await staffOnly(c, user, id, false);
    const { rows } = await c.query(
      `SELECT n.id,n.body,n.created_at,n.author_id,u.name author_name
      FROM load_notes n JOIN users u ON u.id=n.author_id
      WHERE n.load_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 200`,
      [id],
    );
    return { notes: rows };
  });
}

export async function addNote(user: string, id: string, input: unknown) {
  const data = noteSchema.parse(input);
  return transaction(async (c) => {
    const load = await staffOnly(c, user, id, false);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":note:" + data.idempotency_key,
    ]);
    const hash = digest(JSON.stringify({ load_id: id, body: data.body }));
    const old = await c.query(
      "SELECT id,request_hash FROM load_notes WHERE author_id=$1 AND idempotency_key=$2",
      [user, data.idempotency_key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { id: old.rows[0].id as string };
    }
    const noteId = randomUUID();
    await c.query(
      `INSERT INTO load_notes(id,load_id,carrier_id,author_id,body,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        noteId,
        id,
        load.carrier_id,
        user,
        data.body,
        data.idempotency_key,
        hash,
      ],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'load.note.added',$3,now())",
      [randomUUID(), user, id],
    );
    return { id: noteId };
  });
}
