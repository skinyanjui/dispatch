/**
 * Production settings that weaken security when missing. Returned as plain
 * sentences so the build log and the operations status can show them. The
 * build fails on them only when RELAY_STRICT_CONFIG=true.
 */
export function configWarnings(
  env: Record<string, string | undefined> = process.env,
) {
  const warnings: string[] = [];
  const key = env.RELAY_DATA_KEY
    ? Buffer.from(env.RELAY_DATA_KEY, "base64").length
    : 0;
  if (key !== 32)
    warnings.push(
      "RELAY_DATA_KEY is missing or not 32 base64 bytes: reset emails and second-factor setup are unavailable.",
    );
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 16)
    warnings.push(
      "CRON_SECRET is missing or shorter than 16 characters: the scheduled job is disabled.",
    );
  if (!env.APP_ORIGIN && !env.VERCEL_PROJECT_PRODUCTION_URL)
    warnings.push(
      "APP_ORIGIN is not set: emailed links and provider callbacks cannot be trusted.",
    );
  if (env.RELAY_REQUIRE_MALWARE_SCAN !== "true")
    warnings.push(
      "RELAY_REQUIRE_MALWARE_SCAN is not true: uploads are stored without a malware scan.",
    );
  return warnings;
}
