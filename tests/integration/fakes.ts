import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { presignUrl, sha256Hex } from "../../src/lib/sigv4";
import { s3Client } from "../../src/lib/storage";

// AWS example credentials from the S3 SigV4 documentation.
export const aws = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
export const eicar =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Minimal S3 behaviour: SigV4 header shape and payload checksum, write-once
 * PUT, HEAD/GET, server-side copy, and presigned GET/PUT. A presigned PUT
 * that signed content-length rejects any other body size, as S3 does.
 */
export async function startFakeS3() {
  const objects = new Map<string, { body: Buffer; sha256: string }>();
  const state = { down: false, putAttempts: 0 };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://local");
    const key = decodeURIComponent(url.pathname);
    if (state.down) return res.writeHead(500).end();
    const presigned = url.searchParams.has("X-Amz-Signature");
    if (presigned) {
      // Like S3: recompute the signature from the request as received, with
      // the signed headers' actual values. A body of a different size
      // changes content-length and therefore the signature.
      const signedNames = (
        url.searchParams.get("X-Amz-SignedHeaders") || ""
      ).split(";");
      const unsigned = new URL(url);
      for (const name of [...unsigned.searchParams.keys()])
        if (name.startsWith("X-Amz-")) unsigned.searchParams.delete(name);
      const headers: Record<string, string> = {};
      for (const name of signedNames)
        if (name !== "host") headers[name] = String(req.headers[name] ?? "");
      const amz = url.searchParams.get("X-Amz-Date")!;
      const date = new Date(
        `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
      );
      const expected = presignUrl(
        aws,
        req.method!,
        new URL(
          "http://" + req.headers.host + unsigned.pathname + unsigned.search,
        ),
        Number(url.searchParams.get("X-Amz-Expires")),
        date,
        headers,
      );
      if (
        new URL(expected).searchParams.get("X-Amz-Signature") !==
        url.searchParams.get("X-Amz-Signature")
      )
        return res.writeHead(403).end();
    } else {
      const auth = req.headers.authorization || "";
      if (
        !auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/") ||
        !auth.includes("SignedHeaders=") ||
        req.headers["x-amz-content-sha256"] !== sha256Hex(body)
      )
        return res.writeHead(403).end();
    }
    if (req.method === "PUT") {
      state.putAttempts++;
      const source = req.headers["x-amz-copy-source"];
      if (source) {
        const from = objects.get(decodeURIComponent(String(source)));
        if (!from) return res.writeHead(404).end();
        objects.set(key, {
          body: from.body,
          sha256: String(req.headers["x-amz-meta-sha256"]),
        });
        return res.writeHead(200).end("<CopyObjectResult></CopyObjectResult>");
      }
      if (req.headers["if-none-match"] === "*" && objects.has(key))
        return res.writeHead(412).end();
      objects.set(key, {
        body,
        sha256: String(req.headers["x-amz-meta-sha256"] ?? ""),
      });
      return res.writeHead(200).end();
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return res.writeHead(204).end();
    }
    const object = objects.get(key);
    if (!object) return res.writeHead(404).end();
    res.writeHead(200, {
      "content-length": object.body.length,
      "x-amz-meta-sha256": object.sha256,
      ...(presigned
        ? {
            "content-disposition":
              url.searchParams.get("response-content-disposition") ?? "",
            "content-type": url.searchParams.get("response-content-type") ?? "",
          }
        : {}),
    });
    res.end(req.method === "HEAD" ? undefined : object.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    objects,
    state,
    close: () => server.close(),
    client: (bucket = "relay-docs") =>
      s3Client({
        endpoint: url,
        region: aws.region,
        bucket,
        accessKeyId: aws.accessKeyId,
        secretAccessKey: aws.secretAccessKey,
        virtualHosted: false,
      }),
  };
}

/** clamd INSTREAM: reports EICAR as infected, "SCANNER-ERROR" as an error. */
export async function startFakeClamd() {
  const server = createTcpServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (d) => {
      buffer = Buffer.concat([buffer, Buffer.from(d)]);
      const header = Buffer.from("zINSTREAM\0");
      if (buffer.length < header.length) return;
      let offset = header.length;
      const parts: Buffer[] = [];
      while (offset + 4 <= buffer.length) {
        const size = buffer.readUInt32BE(offset);
        if (size === 0) {
          const content = Buffer.concat(parts).toString("latin1");
          socket.end(
            content.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")
              ? "stream: Eicar-Test-Signature FOUND\0"
              : content.includes("SCANNER-ERROR")
                ? "INSTREAM size limit exceeded. ERROR\0"
                : "stream: OK\0",
          );
          return;
        }
        if (offset + 4 + size > buffer.length) return;
        parts.push(buffer.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () => server.close(),
  };
}
