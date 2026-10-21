import { randomUUID } from "node:crypto";
import { pool, transaction } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
if (!process.env.SEED_PASSWORD || process.env.SEED_PASSWORD.length < 12)
  throw new Error(
    "Set SEED_PASSWORD to at least 12 characters; fictional local QA only",
  );
try {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(813372)");
    const existing = await c.query(
      "SELECT 1 FROM users WHERE email='dispatcher@relay.test'",
    );
    if (existing.rowCount) return;
    const org = randomUUID();
    await c.query("INSERT INTO organizations VALUES($1,$2)", [org, "Relay QA"]);
    const carriers = [randomUUID(), randomUUID()];
    const drivers = [randomUUID(), randomUUID()];
    for (let i = 0; i < 2; i++) {
      await c.query("INSERT INTO carriers VALUES($1,$2,$3)", [
        carriers[i],
        org,
        ["Blue Ridge Transport", "Prairie Line Logistics"][i],
      ]);
      await c.query("INSERT INTO drivers VALUES($1,$2,$3)", [
        drivers[i],
        carriers[i],
        ["Jordan Ellis", "Morgan Reed"][i],
      ]);
      await c.query(
        "INSERT INTO carrier_dispatch_authorizations VALUES($1,$2,$3,now(),now()-interval '1 day',now()+interval '1 year')",
        [randomUUID(), carriers[i], "FICTIONAL-QA-AGREEMENT"],
      );
    }
    for (const [email, name, role, indices] of [
      ["dispatcher@relay.test", "Alex Morgan", "dispatcher", [0, 1]],
      ["carrier@relay.test", "Casey Lane", "carrier-manager", [0]],
      ["driver@relay.test", "Jordan Ellis", "driver", [0]],
    ] as const) {
      const id = randomUUID();
      await c.query("INSERT INTO users VALUES($1,$2,$3,$4)", [
        id,
        email,
        hashPassword(process.env.SEED_PASSWORD!),
        name,
      ]);
      for (const i of indices)
        await c.query("INSERT INTO memberships VALUES($1,$2,$3,$4)", [
          id,
          carriers[i],
          role,
          role === "driver" ? drivers[i] : null,
        ]);
    }
    // Fictional QA addresses are treated as verified; the dispatcher owns
    // the QA organization.
    await c.query(
      "UPDATE users SET email_verified_at=now() WHERE email LIKE '%@relay.test'",
    );
    await c.query(
      "INSERT INTO organization_members(organization_id,user_id,role) SELECT $1,id,'owner' FROM users WHERE email='dispatcher@relay.test' ON CONFLICT(organization_id,user_id) DO UPDATE SET role='owner'",
      [org],
    );
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      await c.query(
        "INSERT INTO loads(id,carrier_id,reference,source,amount_minor) VALUES($1,$2,$3,$4,$5)",
        [
          id,
          carriers[i],
          `RL-10${i + 1}`,
          "Fictional QA seed",
          245000 + i * 35000,
        ],
      );
      for (let j = 0; j < 2; j++)
        await c.query(
          "INSERT INTO load_stops VALUES($1,$2,$3,$4,$5,$6,now()+($7*interval '1 day'),now()+($7*interval '1 day')+interval '1 hour')",
          [
            randomUUID(),
            id,
            j + 1,
            j === 0 ? "pickup" : "delivery",
            j === 0 ? "Chicago, IL" : "Nashville, TN",
            "America/Chicago",
            j + 1,
          ],
        );
      await c.query(
        "INSERT INTO load_assignments(load_id,carrier_id,driver_id) VALUES($1,$2,$3)",
        [id, carriers[i], drivers[i]],
      );
    }
  });
  console.log("Fictional QA fixtures ready");
} finally {
  await pool.end();
}
