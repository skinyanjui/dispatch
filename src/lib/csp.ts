// Scripts run only with this request's nonce ('strict-dynamic' lets those
// scripts load their own chunks), so injected markup cannot execute. Styles
// keep 'unsafe-inline' because React components set style attributes.
// Direct uploads go from the browser to the object-storage host, so that host
// may be connected to. It is read per request, so a restart picks up S3_*
// changes. RELAY_CSP_CONNECT_EXTRA adds more origins (space separated).
function storageOrigins() {
  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  const origins: string[] = [];
  if (endpoint) {
    const base = new URL(endpoint);
    origins.push(
      process.env.S3_VIRTUAL_HOSTED === "true" && bucket
        ? `${base.protocol}//${bucket}.${base.host}`
        : base.origin,
    );
  } else if (bucket) {
    const region = process.env.S3_REGION || "us-east-1";
    origins.push(`https://${bucket}.s3.${region}.amazonaws.com`);
  }
  origins.push(
    ...(process.env.RELAY_CSP_CONNECT_EXTRA || "").split(/\s+/).filter(Boolean),
  );
  return origins.length ? " " + origins.join(" ") : "";
}
export function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${storageOrigins()}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
