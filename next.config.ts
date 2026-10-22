import type { NextConfig } from "next";
// Next.js emits inline bootstrap scripts and React inline styles, so both allow
// 'unsafe-inline'; everything else is limited to this origin. Direct uploads go
// from the browser to the object-storage endpoint, so it is allowed to connect.
function contentSecurityPolicy() {
  const storage = process.env.S3_ENDPOINT
    ? " " + new URL(process.env.S3_ENDPOINT).origin
    : "";
  const bucket =
    process.env.S3_BUCKET && !process.env.S3_ENDPOINT
      ? ` https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION || "us-east-1"}.amazonaws.com`
      : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${storage}${bucket}`,
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
