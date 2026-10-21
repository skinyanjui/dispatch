import type { PoolClient } from "pg";
import { presignUrl, rfc3986, sha256Hex, signRequest } from "./sigv4";

// Document bytes live in one of two backends, chosen per object and recorded
// in document_objects.backend (ADR 0012):
// - postgres: bytea written in the same transaction as the version record.
// - s3: any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO). Bytes are
//   written before the version transaction with a conditional PUT, so a
//   retried upload can never overwrite different content under the same key.
export class StorageUnavailable extends Error {}

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  virtualHosted: boolean;
};
export function s3ConfigFromEnv(): S3Config | null {
  if (process.env.RELAY_DOCUMENT_STORE !== "s3") return null;
  const required = {
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  };
  for (const [name, value] of Object.entries(required))
    if (!value)
      throw new Error(
        `RELAY_DOCUMENT_STORE=s3 requires ${name} (see .env.example)`,
      );
  return {
    endpoint: required.endpoint!.replace(/\/$/, ""),
    bucket: required.bucket!,
    accessKeyId: required.accessKeyId!,
    secretAccessKey: required.secretAccessKey!,
    region: process.env.S3_REGION || "us-east-1",
    virtualHosted: process.env.S3_VIRTUAL_HOSTED === "true",
  };
}

export function s3Client(config: S3Config, fetcher: typeof fetch = fetch) {
  const creds = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  };
  const objectUrl = (key: string) => {
    const path = key.split("/").map(rfc3986).join("/");
    if (!config.virtualHosted)
      return new URL(`${config.endpoint}/${rfc3986(config.bucket)}/${path}`);
    const base = new URL(config.endpoint);
    return new URL(`${base.protocol}//${config.bucket}.${base.host}/${path}`);
  };
  async function call(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ) {
    const url = objectUrl(key);
    const signed = signRequest(
      creds,
      method,
      url,
      headers,
      body ? sha256Hex(body) : sha256Hex(""),
    );
    try {
      return await fetcher(url, {
        method,
        headers: signed,
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new StorageUnavailable(
        "Object storage request failed: " +
          (e instanceof Error ? e.name : "unknown"),
      );
    }
  }
  return {
    bucket: config.bucket,
    async head(key: string) {
      const response = await call("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok)
        throw new StorageUnavailable(`HEAD responded ${response.status}`);
      return {
        size: Number(response.headers.get("content-length")),
        sha256: response.headers.get("x-amz-meta-sha256"),
      };
    },
    /** Write-once: an existing object is accepted only if it is identical. */
    async put(key: string, content: Buffer, sha256: string) {
      const response = await call(
        "PUT",
        key,
        {
          "content-type": "application/octet-stream",
          "if-none-match": "*",
          "x-amz-meta-sha256": sha256,
        },
        content,
      );
      if (response.ok) return;
      if (response.status === 412 || response.status === 409) {
        const existing = await this.head(key);
        if (existing?.sha256 === sha256 && existing.size === content.length)
          return;
        throw new StorageUnavailable(
          "A different object already uses this key",
        );
      }
      throw new StorageUnavailable(`PUT responded ${response.status}`);
    },
    /** Removes an object. Only abandoned-upload cleanup calls this. */
    async delete(key: string) {
      const response = await call("DELETE", key);
      if (!response.ok && response.status !== 404)
        throw new StorageUnavailable(`DELETE responded ${response.status}`);
    },
    async get(key: string) {
      const response = await call("GET", key);
      if (!response.ok)
        throw new StorageUnavailable(`GET responded ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    /**
     * Presigned PUT for a browser upload. Content-Length is a signed header,
     * so the provider rejects a body of any other size.
     */
    presignUpload(key: string, size: number, seconds = 900) {
      return presignUrl(creds, "PUT", objectUrl(key), seconds, new Date(), {
        "content-length": String(size),
        "content-type": "application/octet-stream",
      });
    },
    /** Server-side copy to a write-once key, keeping a checksum tag. */
    async copy(fromKey: string, toKey: string, sha256: string) {
      const existing = await this.head(toKey);
      if (existing) {
        if (existing.sha256 === sha256) return;
        throw new StorageUnavailable(
          "A different object already uses this key",
        );
      }
      const source =
        "/" +
        rfc3986(config.bucket) +
        "/" +
        fromKey.split("/").map(rfc3986).join("/");
      const response = await call("PUT", toKey, {
        "x-amz-copy-source": source,
        "x-amz-metadata-directive": "REPLACE",
        "content-type": "application/octet-stream",
        "x-amz-meta-sha256": sha256,
      });
      // S3 can report a failed copy inside a 200 response body.
      const text = response.ok ? await response.text() : "";
      if (!response.ok || text.includes("<Error>"))
        throw new StorageUnavailable(`COPY responded ${response.status}`);
    },
    /** Short-lived download URL that forces an attachment download. */
    presignDownload(
      key: string,
      filename: string,
      contentType: string,
      seconds = 60,
    ) {
      const url = objectUrl(key);
      url.searchParams.set(
        "response-content-disposition",
        `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      url.searchParams.set("response-content-type", contentType);
      return presignUrl(creds, "GET", url, seconds);
    },
  };
}
export type S3Client = ReturnType<typeof s3Client>;

let override: S3Client | null | undefined;
/** Tests inject a client; production reads configuration once per call. */
export function setObjectStore(client: S3Client | null | undefined) {
  override = client;
}
export function objectStore(): S3Client | null {
  if (override !== undefined) return override;
  const config = s3ConfigFromEnv();
  return config ? s3Client(config) : null;
}

export async function readPostgresObject(c: PoolClient, key: string) {
  const { rows } = await c.query(
    "SELECT content FROM document_objects WHERE storage_key=$1 AND backend='postgres'",
    [key],
  );
  return (rows[0]?.content as Buffer | undefined) ?? null;
}
