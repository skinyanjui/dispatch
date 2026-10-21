import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Vercel supplies these variables to its build process. Preview builds must
// never migrate a possibly shared production database.
if (process.env.VERCEL_ENV !== "production") {
  console.log("Skipping database preparation outside Vercel Production.");
} else {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      "Production build requires DATABASE_URL. Connect PostgreSQL in Vercel, then redeploy.",
    );
    process.exit(1);
  }
  const qa = process.env.RELAY_QA_SEED;
  if (qa && qa !== "true" && qa !== "false") {
    console.error(
      "RELAY_QA_SEED must be true or false. Use true only for a dedicated fictional QA database.",
    );
    process.exit(1);
  }
  if (
    qa === "true" &&
    (!process.env.SEED_PASSWORD || process.env.SEED_PASSWORD.length < 12)
  ) {
    console.error(
      "QA setup requires SEED_PASSWORD with at least 12 characters. Set it privately in Vercel.",
    );
    process.exit(1);
  }

  function run(script: string) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url))],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    if (result.error || result.status !== 0) {
      console.error(
        "Database preparation failed. Deployment stopped; resolve the database error and redeploy.",
      );
      process.exit(result.status || 1);
    }
  }

  console.log("Preparing Production database: applying pending migrations.");
  run("./migrate.ts");
  if (qa === "true") {
    console.log(
      "Initializing explicitly enabled fictional QA accounts and fixtures.",
    );
    run("./seed.ts");
  } else {
    console.log(
      "QA seeding disabled. Existing accounts and data are preserved.",
    );
  }
  console.log("Production database preparation complete.");
}
