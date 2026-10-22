/** The only part of a render error that is safe to log or show: Next.js's
 *  opaque digest, which matches the server log line. Messages and stacks can
 *  contain record ids or text from the request, so they are never kept. */
export function errorDigest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && /^[\w-]{1,40}$/.test(digest)
    ? digest
    : undefined;
}
export function logUiError(error: unknown) {
  console.error("ui.error", { digest: errorDigest(error) ?? null });
}
