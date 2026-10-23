// Restore rehearsal for disposable local QA databases. Never targets production.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import pg from "pg";
process.umask(0o077);
const url = new URL(process.env.DATABASE_URL ?? "");
const database = decodeURIComponent(url.pathname.slice(1));
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  !/^relay_(qa|repair|test)/.test(database)
)
  throw Error(
    "Restore verification requires an isolated local relay_qa*, relay_repair* or relay_test* database",
  );
const temporary = "relay_restore_" + randomBytes(8).toString("hex");
const container = process.env.RELAY_TEST_PG_CONTAINER || "dispatch-db-1";
const directory = await mkdtemp("/tmp/relay-restore-");
const passphrase = randomBytes(48).toString("base64");
const pguser = decodeURIComponent(url.username);
const dockerEnv = { ...process.env };
for (const key of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete dockerEnv[key];
const docker = (args, input) =>
  execFileSync(
    "docker",
    [
      "--host=unix:///var/run/docker.sock",
      "exec",
      ...(input ? ["-i"] : []),
      container,
      ...args,
    ],
    { input, env: dockerEnv, maxBuffer: 256 * 1024 * 1024 },
  );
const source = new pg.Client({ connectionString: url.toString() });
let target;
async function counts(client) {
  const names = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const out = {};
  for (const { tablename } of names) {
    const name = '"' + tablename.replaceAll('"', '""') + '"';
    out[tablename] = (
      await client.query("SELECT count(*)::text n FROM " + name)
    ).rows[0].n;
  }
  return out;
}
try {
  await source.connect();
  const before = await counts(source);
  const backup = docker([
    "pg_dump",
    "-U",
    pguser,
    "-d",
    database,
    "--format=custom",
    "--no-owner",
    "--no-acl",
  ]);
  const plain = directory + "/qa.dump",
    encrypted = directory + "/qa.dump.gpg",
    recovered = directory + "/restored.dump";
  await writeFile(plain, backup, { mode: 0o600 });
  await mkdir(directory + "/gnupg", { mode: 0o700 });
  const gpg = (args) =>
    execFileSync(
      "gpg",
      [
        "--homedir",
        directory + "/gnupg",
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-fd",
        "0",
        ...args,
      ],
      { input: passphrase + "\n", stdio: ["pipe", "pipe", "pipe"] },
    );
  gpg(["--symmetric", "--cipher-algo", "AES256", "--output", encrypted, plain]);
  await rm(plain);
  gpg(["--decrypt", "--output", recovered, encrypted]);
  await source.query("CREATE DATABASE " + temporary);
  docker(
    [
      "pg_restore",
      "-U",
      pguser,
      "--no-owner",
      "--no-acl",
      "--dbname",
      temporary,
    ],
    await readFile(recovered),
  );
  const restoredUrl = new URL(url);
  restoredUrl.pathname = "/" + temporary;
  target = new pg.Client({ connectionString: restoredUrl.toString() });
  await target.connect();
  const after = await counts(target);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("Restored table counts differ from the source snapshot");
  await target.query("BEGIN");
  const mutation = await target.query(
    "SELECT load_id FROM load_events LIMIT 1",
  );
  if (mutation.rowCount) {
    let rejected = false;
    try {
      await target.query(
        "UPDATE load_events SET type='restore-test' WHERE load_id=$1",
        [mutation.rows[0].load_id],
      );
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw Error("Immutable history trigger missing after restore");
  }
  await target.query("ROLLBACK");
  console.log(
    JSON.stringify({
      result: "passed",
      tables: Object.keys(before).length,
      encrypted_backup: true,
      row_counts_match: true,
      immutable_history_verified: !!mutation.rowCount,
      temporary_database_removed_on_exit: true,
    }),
  );
} finally {
  if (target) await target.end();
  await source
    .query("DROP DATABASE IF EXISTS " + temporary)
    .catch(() => undefined);
  await source.end();
  await rm(directory, { recursive: true, force: true });
}
