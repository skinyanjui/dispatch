import { createHash, createHmac } from "node:crypto";

// AWS Signature Version 4 for S3-compatible object storage (AWS S3,
// Cloudflare R2, MinIO, Backblaze B2 S3 API). Verified against the published
// S3 examples in tests/integration/object-storage.test.ts.
export type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
};
export const emptyHash = createHash("sha256").update("").digest("hex");
export const sha256Hex = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as S3 expects (unreserved characters only). */
export const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const canonicalPath = (path: string) =>
  path
    .split("/")
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join("/") || "/";
const canonicalQuery = (params: URLSearchParams) =>
  [...params.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) =>
      a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
    )
    .map(([k, v]) => k + "=" + v)
    .join("&");
const stamp = (date: Date) => date.toISOString().replace(/[-:]|\.\d{3}/g, "");

function signature(
  creds: Credentials,
  amzDate: string,
  canonicalRequest: string,
) {
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${creds.region}/${creds.service ?? "s3"}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  let key = hmac("AWS4" + creds.secretAccessKey, day);
  key = hmac(key, creds.region);
  key = hmac(key, creds.service ?? "s3");
  key = hmac(key, "aws4_request");
  return {
    scope,
    value: createHmac("sha256", key).update(toSign).digest("hex"),
  };
}

/** Returns headers (including Authorization) for a signed request. */
export function signRequest(
  creds: Credentials,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  date = new Date(),
) {
  const amzDate = stamp(date);
  const all: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(all).sort();
  const canonical = [
    method,
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, " ")}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const sig = signature(creds, amzDate, canonical);
  const { host, ...rest } = all;
  void host;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${sig.scope}, SignedHeaders=${names.join(";")}, Signature=${sig.value}`,
  };
}

/** Query-string presigned URL (host header only, unsigned payload). */
export function presignUrl(
  creds: Credentials,
  method: string,
  url: URL,
  expiresSeconds: number,
  date = new Date(),
  /** Extra headers the client must send unchanged (e.g. content-length). */
  headers: Record<string, string> = {},
) {
  const extra = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
  );
  const amzDate = stamp(date);
  const signed = new URL(url);
  const scope = `${amzDate.slice(0, 8)}/${creds.region}/${creds.service ?? "s3"}/aws4_request`;
  signed.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  signed.searchParams.set("X-Amz-Credential", `${creds.accessKeyId}/${scope}`);
  signed.searchParams.set("X-Amz-Date", amzDate);
  signed.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const all: Record<string, string> = { ...extra, host: signed.host };
  const names = Object.keys(all).sort();
  signed.searchParams.set("X-Amz-SignedHeaders", names.join(";"));
  const canonical = [
    method,
    canonicalPath(signed.pathname),
    canonicalQuery(signed.searchParams),
    names.map((n) => `${n}:${all[n]}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const sig = signature(creds, amzDate, canonical);
  // Append last so the canonical query above excludes the signature itself.
  return (
    signed.origin +
    signed.pathname +
    "?" +
    canonicalQuery(signed.searchParams) +
    "&X-Amz-Signature=" +
    sig.value
  );
}
