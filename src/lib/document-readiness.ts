import type { LoadDocumentType } from "./compliance";
/**
 * Effective slot semantics shared by reports and exact record filtering:
 * newest version, then latest review of that version. Never accept history.
 * Uses trusted SQL aliases only, never user-supplied text.
 */
export function acceptedCurrentDocument(load: string, type: LoadDocumentType) {
  return `EXISTS(SELECT 1 FROM documents readiness_document
    JOIN LATERAL (SELECT id,expires_on FROM document_versions WHERE document_id=readiness_document.id ORDER BY version DESC LIMIT 1) readiness_version ON true
    JOIN LATERAL (SELECT decision FROM document_reviews WHERE version_id=readiness_version.id ORDER BY created_at DESC,id DESC LIMIT 1) readiness_review ON true
    WHERE readiness_document.load_id=${load}.id AND readiness_document.type='${type}'
      AND readiness_review.decision='accepted'
      AND (readiness_version.expires_on IS NULL OR readiness_version.expires_on>(now() AT TIME ZONE 'UTC')::date+30))`;
}
