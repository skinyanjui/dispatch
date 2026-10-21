import { randomUUID } from "node:crypto";
import { pool, transaction } from "../src/lib/db";
import { hashNewPassword } from "../src/lib/auth";

// Bootstraps a dispatch organization and its first owner. There is no public
// signup; run this once per organization with values supplied privately:
//   ORG_NAME="Acme Dispatch" OWNER_EMAIL=ops@acme.example OWNER_NAME="Pat Lee" \
//   OWNER_PASSWORD='…at least 12 characters…' npm run org:create
// An existing account with OWNER_EMAIL keeps its password and becomes owner.
const name = process.env.ORG_NAME?.trim();
const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
const owner = process.env.OWNER_NAME?.trim();
const password = process.env.OWNER_PASSWORD;
if (!name || !email || !owner || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  throw new Error("Set ORG_NAME, OWNER_NAME and a valid OWNER_EMAIL");
try {
  const result = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "org-bootstrap:" + email,
    ]);
    let user = (await c.query("SELECT id FROM users WHERE email=$1", [email]))
      .rows[0]?.id as string | undefined;
    if (!user) {
      if (!password || password.length < 12)
        throw new Error("Set OWNER_PASSWORD (at least 12 characters)");
      user = randomUUID();
      await c.query(
        "INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,$4)",
        [user, email, await hashNewPassword(password), owner],
      );
    }
    const org = randomUUID();
    await c.query("INSERT INTO organizations VALUES($1,$2)", [org, name]);
    await c.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [org, user],
    );
    await c.query(
      "INSERT INTO audit_logs VALUES($1,$2,'organization.created',$3,now())",
      [randomUUID(), user, org],
    );
    return org;
  });
  console.log("Organization created:", result);
} finally {
  await pool.end();
}
