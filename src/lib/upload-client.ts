"use client";
import { ApiError, type api as httpApi } from "./client-api";
import { maxDirectUploadBytes, maxDocumentBytes } from "./compliance";

export type UploadFields = {
  carrier_id: string;
  load_id?: string;
  type: string;
  expires_on?: string;
  /** Stable across retries of the same file and fields. */
  idempotency_key: string;
};
export type UploadResult = {
  document_id: string;
  version_id: string;
  version: number;
};

async function sha256Hex(file: Blob) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Files up to 4 MB go through the app server. Larger files (up to 25 MB) go
 * straight to the bucket with a presigned PUT, then the server verifies and
 * scans them before they become a document (ADR 0015). Retrying with the same
 * idempotency key resumes or replays rather than duplicating.
 */
export async function uploadDocumentFile(
  api: typeof httpApi,
  fields: UploadFields,
  file: File,
  options: { demo?: boolean } = {},
): Promise<UploadResult> {
  if (file.size > maxDirectUploadBytes)
    throw new ApiError(413, "FILE_TOO_LARGE");
  if (file.size <= maxDocumentBytes || options.demo) {
    const body = new FormData();
    for (const [name, value] of Object.entries(fields))
      if (value) body.set(name, value);
    body.set("file", file);
    return api<UploadResult>("documents", body);
  }
  const session = await api<
    | ({ status: "finalized" } & UploadResult)
    | {
        status: "pending";
        session_id: string;
        upload_url: string;
        upload_headers: Record<string, string>;
      }
  >("documents/uploads", {
    ...fields,
    filename: file.name,
    size_bytes: file.size,
    sha256: await sha256Hex(file),
  });
  if (session.status === "finalized") return session;
  let put: Response;
  try {
    put = await fetch(session.upload_url, {
      method: "PUT",
      headers: session.upload_headers,
      body: file,
    });
  } catch {
    throw new ApiError(503, "UPLOAD_NOT_RECEIVED");
  }
  if (!put.ok) throw new ApiError(503, "UPLOAD_NOT_RECEIVED");
  return api<UploadResult>(
    `documents/uploads/${session.session_id}/finalize`,
    {},
  );
}
