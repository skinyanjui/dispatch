"use client";
import { useRef, useState } from "react";
import {
  FileTextIcon,
  UploadSimpleIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { describe, useApi, ApiError } from "@/lib/client-api";
import {
  documentLabels,
  documentStatusLabels,
  expiringTypes,
  maxDocumentBytes,
  type DocumentSlot,
  type DocumentType,
  type DocumentVersion,
} from "@/lib/compliance";

function size(bytes: number) {
  return bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
}
function when(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function VersionLine({
  version,
  downloads,
}: {
  version: DocumentVersion;
  downloads: boolean;
}) {
  return (
    <div className="docVersion">
      <span>
        v{version.version} · {version.filename} · {size(version.size_bytes)}
      </span>
      <small>
        Uploaded by {version.uploader_name} · {when(version.uploaded_at)}
        {version.expires_on && <> · Expires {version.expires_on}</>}
      </small>
      {version.review && (
        <small>
          {version.review.decision === "accepted" ? "Accepted" : "Rejected"} by{" "}
          {version.review.reviewer_name}
          {version.review.note && <> — “{version.review.note}”</>}
        </small>
      )}
      {downloads && (
        <a
          className="textButton"
          href={`/api/documents/${version.id}/content`}
          aria-label={`Download ${version.filename} version ${version.version}`}
        >
          <DownloadSimpleIcon size={14} aria-hidden="true" />
          Download
        </a>
      )}
    </div>
  );
}

function Slot({
  slot,
  carrierId,
  loadId,
  canUpload,
  canReview,
  downloads,
  disabled,
  onChanged,
}: {
  slot: DocumentSlot;
  carrierId: string;
  loadId?: string;
  canUpload: boolean;
  canReview: boolean;
  downloads: boolean;
  disabled: boolean;
  onChanged: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [rejecting, setRejecting] = useState(false);
  // One retry identity per selected file + metadata, so an uncertain upload
  // can be retried without creating a second version.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const label = documentLabels[slot.type as DocumentType];
  const id = `doc-${slot.type}-${loadId || carrierId}`;
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    try {
      await onChanged(await fn());
    } catch (e) {
      setError(
        describe(e instanceof ApiError ? e.message : "SERVICE_UNAVAILABLE"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="docSlot" aria-labelledby={id + "-title"}>
      <div className="docHeading">
        <FileTextIcon size={17} aria-hidden="true" />
        <h4 id={id + "-title"}>{label}</h4>
        <span className={"docStatus " + slot.status}>
          {documentStatusLabels[slot.status]}
        </span>
      </div>
      {slot.current ? (
        <VersionLine version={slot.current} downloads={downloads} />
      ) : (
        <p className="helpText">No file on record.</p>
      )}
      {slot.history.length > 1 && (
        <details className="docHistory">
          <summary>Earlier versions ({slot.history.length - 1})</summary>
          {slot.history.slice(1).map((v) => (
            <VersionLine key={v.id} version={v} downloads={downloads} />
          ))}
        </details>
      )}
      {canReview && slot.current && !slot.current.review && !rejecting && (
        <div className="docActions">
          <button
            className="secondary"
            disabled={disabled || busy}
            onClick={() =>
              run(async () => {
                await api(`documents/${slot.current!.id}/review`, {
                  decision: "accepted",
                });
                return `${label} accepted.`;
              })
            }
          >
            Accept
          </button>
          <button
            className="secondary"
            disabled={disabled || busy}
            onClick={() => setRejecting(true)}
          >
            Reject
          </button>
        </div>
      )}
      {rejecting && slot.current && (
        <form
          className="docForm"
          onSubmit={(e) => {
            e.preventDefault();
            const note = String(new FormData(e.currentTarget).get("note"));
            run(async () => {
              await api(`documents/${slot.current!.id}/review`, {
                decision: "rejected",
                note,
              });
              setRejecting(false);
              return `${label} rejected.`;
            });
          }}
        >
          <label>
            Reason for rejection
            <input name="note" required maxLength={1000} />
          </label>
          <div className="docActions">
            <button className="primary" disabled={disabled || busy}>
              Reject file
            </button>
            <button
              type="button"
              className="textButton"
              onClick={() => setRejecting(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {canUpload && (
        <form
          className="docForm"
          onSubmit={(e) => {
            e.preventDefault();
            const formElement = e.currentTarget;
            const f = new FormData(formElement);
            const file = f.get("file");
            if (!(file instanceof File) || !file.size) {
              setError(describe("FILE_REQUIRED"));
              return;
            }
            if (file.size > maxDocumentBytes) {
              setError(describe("FILE_TOO_LARGE"));
              return;
            }
            const expires = String(f.get("expires_on") || "");
            const signature = [
              file.name,
              file.size,
              file.lastModified,
              expires,
            ].join("|");
            if (attempt.current?.signature !== signature)
              attempt.current = { signature, key: crypto.randomUUID() };
            const body = new FormData();
            body.set("carrier_id", carrierId);
            if (loadId) body.set("load_id", loadId);
            body.set("type", slot.type);
            if (expires) body.set("expires_on", expires);
            body.set("idempotency_key", attempt.current.key);
            body.set("file", file);
            run(async () => {
              await api("documents", body);
              attempt.current = null;
              formElement.reset();
              return `${label} uploaded for review.`;
            });
          }}
        >
          <label>
            {slot.current ? "Upload new version" : "Upload file"}
            <input
              name="file"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              required
            />
          </label>
          {expiringTypes.includes(slot.type) && (
            <label>
              Policy expiry date
              <input name="expires_on" type="date" required />
            </label>
          )}
          <button
            className="secondary"
            disabled={disabled || busy}
            aria-label={`Upload ${label}`}
          >
            <UploadSimpleIcon size={15} aria-hidden="true" />
            {busy ? "Uploading…" : "Upload"}
          </button>
          <small>
            PDF, PNG or JPEG up to 4 MB. Files are not virus-scanned yet.
          </small>
        </form>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function DocumentPanel({
  slots,
  carrierId,
  loadId,
  canUpload,
  canReview,
  downloads,
  disabled = false,
  onChanged,
}: {
  slots: DocumentSlot[];
  carrierId: string;
  loadId?: string;
  canUpload: (type: DocumentType) => boolean;
  canReview: boolean;
  downloads: boolean;
  disabled?: boolean;
  onChanged: (message: string) => Promise<void>;
}) {
  return (
    <div className="docPanel">
      {slots.map((slot) => (
        <Slot
          key={slot.type}
          slot={slot}
          carrierId={carrierId}
          loadId={loadId}
          canUpload={canUpload(slot.type)}
          canReview={canReview}
          downloads={downloads}
          disabled={disabled}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
