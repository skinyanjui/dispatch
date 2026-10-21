"use client";
import { useCallback, useEffect, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { Modal } from "./modal";
import { DocumentPanel } from "./document-panel";
import { ApiError, describe, useApi } from "@/lib/client-api";
import type { CarrierDocuments } from "@/lib/contracts";

export function CarrierDocumentsDialog({
  carrierId,
  carrierName,
  demo,
  offline,
  onClose,
  onAuthError,
}: {
  carrierId: string;
  carrierName: string;
  demo: boolean;
  offline: boolean;
  onClose: () => void;
  onAuthError: (e: unknown) => void;
}) {
  const api = useApi();
  const [data, setData] = useState<CarrierDocuments | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api<CarrierDocuments>(`carriers/${carrierId}/documents`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthError(e);
      setError(e instanceof Error ? e.message : "SERVICE_UNAVAILABLE");
    } finally {
      setLoading(false);
    }
  }, [api, carrierId, onAuthError]);
  useEffect(() => {
    // Initial fetch for the dialog; state updates happen after the request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const gaps = data?.slots.filter((s) => s.status !== "accepted").length ?? 0;
  return (
    <Modal label="Carrier documents" onClose={onClose}>
      <section className="inspector">
        <div className="inspectorHeader">
          <p className="eyebrow">COMPLIANCE FILES</p>
          <button
            autoFocus
            className="iconButton"
            aria-label="Close carrier documents"
            onClick={onClose}
          >
            <XIcon size={20} aria-hidden="true" />
          </button>
        </div>
        <h2 className="detailTitle">{carrierName}</h2>
        {loading && !data && (
          <p className="helpText" role="status">
            Loading documents…
          </p>
        )}
        {error && (
          <div className="alert error" role="alert">
            {describe(error)}
            <button className="secondary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {notice && (
          <p className="inlineNotice" role="status">
            {notice}
          </p>
        )}
        {data && (
          <>
            <p className="helpText" role="status">
              {gaps
                ? `${gaps} of ${data.slots.length} compliance files need attention.`
                : "All compliance files are accepted and current."}
            </p>
            {data.agreement && (
              <p className="helpText">
                Dispatch authorization{" "}
                {data.agreement.current ? "active" : "not current"} · reference
                “{data.agreement.agreement_ref}” ·{" "}
                {data.agreement.document_version_id
                  ? "verified against an uploaded file"
                  : "reference only — no file was linked when it was verified"}
              </p>
            )}
            <DocumentPanel
              slots={data.slots}
              carrierId={carrierId}
              canUpload={() => !offline}
              canReview={data.can_review && !offline}
              downloads={!demo}
              disabled={loading || offline}
              onChanged={async (message) => {
                await load();
                setNotice(message);
              }}
            />
            <p className="detailFoot">
              Insurance expiry is shown for awareness; booking is gated only by
              a current verified dispatch agreement. Uploading a dispatch
              agreement does not verify it — use agreement review in carrier
              setup.
            </p>
          </>
        )}
      </section>
    </Modal>
  );
}
