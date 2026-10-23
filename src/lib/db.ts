import pg from "pg";
/** pg's legacy require/prefer aliases are becoming weaker in the next major.
 * Select hostname/certificate validation explicitly for remote PostgreSQL. */
export function databaseConnectionString(raw: string | undefined) {
  if (!raw) return raw;
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const mode = url.searchParams.get("sslmode");
  if (!local && mode === "disable")
    throw new Error("Remote PostgreSQL must use certificate-verified TLS");
  if (!local && (!mode || ["prefer", "require", "verify-ca"].includes(mode)))
    url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}
export const pool = new pg.Pool({
  connectionString: databaseConnectionString(process.env.DATABASE_URL),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  idle_in_transaction_session_timeout: 15000,
});
pool.on("error", (error) =>
  console.error("database.idle_connection_failure", error.name),
);
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation?: "repeatable read",
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(
      isolation ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
    );
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
