import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Tops the fictional QA workspace up to more than one page (25) of carriers,
 * people and dispatch invoices, so paging tests do not depend on rows left by
 * earlier runs. Idempotent: reruns add nothing.
 */
export async function ensureVolume(target = 30) {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = (
      await db.query(
        "SELECT u.id, c.organization_id FROM users u JOIN memberships m ON m.user_id=u.id JOIN carriers c ON c.id=m.carrier_id WHERE u.email='dispatcher@relay.test' LIMIT 1",
      )
    ).rows[0];
    for (let i = 1; i <= target; i++) {
      const name = `Volume QA ${i}`;
      if (
        (await db.query("SELECT 1 FROM carriers WHERE name=$1", [name]))
          .rowCount
      )
        continue;
      const carrier = randomUUID();
      const manager = randomUUID();
      await db.query("INSERT INTO carriers VALUES($1,$2,$3)", [
        carrier,
        owner.organization_id,
        name,
      ]);
      await db.query(
        "INSERT INTO carrier_dispatch_authorizations(id,carrier_id,agreement_ref,verified_at,effective_at,expires_at) VALUES($1,$2,'Fictional QA agreement',now(),now()-interval '1 day',now()+interval '1 year')",
        [randomUUID(), carrier],
      );
      await db.query(
        "INSERT INTO users(id,email,password_hash,name,email_verified_at) VALUES($1,$2,'not-a-login-fixture',$3,now())",
        [manager, `volume-${manager}@relay.test`, `Volume Manager ${i}`],
      );
      await db.query(
        "INSERT INTO memberships VALUES($1,$2,'dispatcher',NULL)",
        [owner.id, carrier],
      );
      await db.query(
        "INSERT INTO memberships VALUES($1,$2,'carrier-manager',NULL)",
        [manager, carrier],
      );
    }
    // The billing page opens on the first carrier, Blue Ridge Transport.
    const carrier = (
      await db.query(
        "SELECT id FROM carriers WHERE name='Blue Ridge Transport'",
      )
    ).rows[0].id;
    const have = (
      await db.query(
        "SELECT count(*)::int n FROM dispatch_invoices WHERE carrier_id=$1",
        [carrier],
      )
    ).rows[0].n;
    for (let i = have; i < target; i++)
      await db.query(
        `INSERT INTO dispatch_invoices(id,carrier_id,number,status,fee_bps,total_minor,due_on,issued_at,issued_by,created_by,idempotency_key,request_hash)
         VALUES($1,$2,'VOL-'||$3::text||'-'||$4::text,'issued',800,$5,current_date+30,now(),$6,$6,$7,'volume-qa')`,
        [
          randomUUID(),
          carrier,
          Date.now(),
          i,
          10000 + i * 137,
          owner.id,
          randomUUID(),
        ],
      );
  } finally {
    await db.end();
  }
}

/** An issued dispatch invoice for the named carrier (created once, reused). */
export async function invoiceFor(carrierName: string) {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const found = await db.query(
      `SELECT i.id FROM dispatch_invoices i JOIN carriers c ON c.id=i.carrier_id
       WHERE c.name=$1 AND i.request_hash='link-qa' LIMIT 1`,
      [carrierName],
    );
    if (found.rows[0]) return found.rows[0].id as string;
    const owner = (
      await db.query("SELECT id FROM users WHERE email='dispatcher@relay.test'")
    ).rows[0].id;
    const carrier = (
      await db.query("SELECT id FROM carriers WHERE name=$1", [carrierName])
    ).rows[0].id;
    const id = randomUUID();
    await db.query(
      `INSERT INTO dispatch_invoices(id,carrier_id,number,status,fee_bps,total_minor,due_on,issued_at,issued_by,created_by,idempotency_key,request_hash)
       VALUES($1,$2,'LINK-'||$3::text,'issued',800,12345,current_date+30,now(),$4,$4,$5,'link-qa')`,
      [id, carrier, Date.now(), owner, randomUUID()],
    );
    return id;
  } finally {
    await db.end();
  }
}
