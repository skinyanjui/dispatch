import type { NextConfig } from "next";
// Next.js emits inline bootstrap scripts and React inline styles, so both allow
// 'unsafe-inline'; everything else is limited to this origin. Direct uploads go
// from the browser to the object-storage host, so that host may be connected
// to. It is read when the app is built, so rebuild after changing S3_* settings.
// RELAY_CSP_CONNECT_EXTRA adds more origins (space separated), e.g. a CDN.
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
function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${storageOrigins()}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
const config: NextConfig = {
  experimental: { cpus: 2 },
  poweredByHeader: false,
  devIndicators: false,
  async redirects() {
    return [{ source: "/demo.html", destination: "/demo", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
