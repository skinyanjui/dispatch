"use client";
import { useRef, useState } from "react";
import {
  FileTextIcon,
  UploadSimpleIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { describe, useApi, ApiError } from "@/lib/client-api";
import { uploadDocumentFile } from "@/lib/upload-client";
import type { Recorded } from "@/lib/extraction";
import { DocumentReading } from "@/components/document-reading";
import {
  documentLabels,
  documentStatusLabels,
  expiringTypes,
  maxDirectUploadBytes,
  type DocumentSlot,
  type DocumentType,
  type DocumentVersion,
} from "@/lib/compliance";
import { formatDateTimeLong } from "@/lib/format";
import { ErrorAlert } from "@/components/ui/feedback";

function size(bytes: number) {
  return bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
}
const when = formatDateTimeLong;
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
      <small className={version.scan ? "docScan clean" : "docScan"}>
        {version.scan
          ? `Malware scan: clean (${version.scan.engine === "clamav" ? "ClamAV" : version.scan.engine})`
          : "Not malware-scanned (no scanner was configured)"}
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
  demo,
  recordedLoad,
}: {
  demo: boolean;
  recordedLoad: Recorded["load"];
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
        <h3 id={id + "-title"}>{label}</h3>
        <span className={"docStatus " + slot.status}>
          {documentStatusLabels[slot.status]}
        </span>
      </div>
      {slot.current ? (
        <VersionLine version={slot.current} downloads={downloads} />
      ) : (
        <p className="helpText">No file on record.</p>
      )}
      {canReview && slot.current && (
        <DocumentReading
          version={slot.current}
          type={slot.type}
          label={label}
          recorded={{
            expires_on: slot.current.expires_on,
            load: recordedLoad,
          }}
          disabled={disabled || busy}
          onChanged={onChanged}
        />
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
            if (file.size > maxDirectUploadBytes) {
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
            const fields = {
              carrier_id: carrierId,
              ...(loadId ? { load_id: loadId } : {}),
              type: slot.type,
              ...(expires ? { expires_on: expires } : {}),
              idempotency_key: attempt.current.key,
            };
            run(async () => {
              await uploadDocumentFile(api, fields, file, { demo });
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
            PDF, PNG or JPEG up to 25 MB. Each version shows its malware scan
            result.
          </small>
        </form>
      )}
      {error && <ErrorAlert>{error}</ErrorAlert>}
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
  demo = false,
  recordedLoad = null,
}: {
  demo?: boolean;
  /** The load's own values, which a reading is compared with. */
  recordedLoad?: Recorded["load"];
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
          demo={demo}
          recordedLoad={recordedLoad}
        />
      ))}
    </div>
  );
}
