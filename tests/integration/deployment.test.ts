import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { verifyPassword } from "../../src/lib/auth";
import { pool } from "../../src/lib/db";

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const databases: string[] = [];

after(async () => {
  for (const name of databases)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await pool.end();
});

async function freshDatabase() {
  const name = "relay_deploy_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE "${name}"`);
  databases.push(name);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/" + name;
  return {
    url: url.toString(),
    db: new pg.Pool({ connectionString: url.toString() }),
  };
}

function prepare(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/prepare-deployment.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VERCEL_ENV: "production",
        RELAY_QA_SEED: "false",
        ...env,
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
}

test("Production preparation migrates an empty database, repeats safely and never seeds by default", async () => {
  const { url, db } = await freshDatabase();
  try {
    for (let i = 0; i < 2; i++) {
      const result = prepare({ DATABASE_URL: url });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Production database preparation complete/);
    }
    assert.deepEqual(
      (
        await db.query("SELECT version FROM schema_migrations ORDER BY version")
      ).rows.map((r) => r.version),
      ["001", "002", "003", "004"],
    );
    assert.equal((await db.query("SELECT 1 FROM login_attempts")).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM check_ins")).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM users")).rowCount, 0);
  } finally {
    await db.end();
  }
});

test("Production upgrades foundation-only schema and explicitly initializes QA logins without password resets", async () => {
  const { url, db } = await freshDatabase();
  const password = "FictionalDeploymentTestOnly2026";
  try {
    await db.query(
      await readFile(
        new URL("../../db/001_foundation.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.query("INSERT INTO schema_migrations VALUES('001')");
    assert.equal(
      (await db.query("SELECT to_regclass('login_attempts') relation")).rows[0]
        .relation,
      null,
    );
    for (const secret of [password, "ChangedDeploymentTestOnly2026"]) {
      const result = prepare({
        DATABASE_URL: url,
        RELAY_QA_SEED: "true",
        SEED_PASSWORD: secret,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Fictional QA fixtures ready/);
      assert(!result.stdout.includes(secret));
    }
    const users = await db.query(
      "SELECT email,password_hash FROM users ORDER BY email",
    );
    assert.equal(users.rowCount, 3);
    for (const user of users.rows)
      assert(await verifyPassword(password, user.password_hash));
    assert.equal((await db.query("SELECT 1 FROM loads")).rowCount, 2);
    // Exercise the previously failing statement against the upgraded schema.
    await db.query(
      "INSERT INTO login_attempts VALUES('deployment-test',1,now()+interval '1 minute')",
    );
    assert.equal((await db.query("SELECT 1 FROM login_attempts")).rowCount, 1);
  } finally {
    await db.end();
  }
});

test("missing Production database or QA password fails before compilation or database writes", () => {
  const missingDatabase = prepare({ DATABASE_URL: "" });
  assert.equal(missingDatabase.status, 1);
  assert.match(missingDatabase.stderr, /requires DATABASE_URL/);
  const missingPassword = prepare({
    DATABASE_URL: "postgresql://invalid",
    RELAY_QA_SEED: "true",
    SEED_PASSWORD: "",
  });
  assert.equal(missingPassword.status, 1);
  assert.match(missingPassword.stderr, /QA setup requires SEED_PASSWORD/);
  assert(!missingPassword.stdout.includes("applying pending migrations"));
});

test("Preview builds never mutate or seed a shared database even if QA flags are inherited", () => {
  const result = prepare({
    VERCEL_ENV: "preview",
    DATABASE_URL: "postgresql://invalid",
    RELAY_QA_SEED: "true",
    SEED_PASSWORD: "",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipping database preparation/);
});

test("database migration failures stop deployment instead of continuing to compile", () => {
  const result = prepare({
    DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/missing",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Deployment stopped/);
  assert(!result.stdout.includes("Production database preparation complete"));
});
