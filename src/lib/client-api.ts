"use client";
import { createContext, useContext } from "react";
const messages: Record<string, string> = {
  INVITE_UNAVAILABLE:
    "This invitation has expired or has already been used. Ask your carrier contact for a new link, or sign in if you have already joined.",
  INVITE_SIGN_IN_REQUIRED:
    "Sign in with the email on your invitation before joining.",
  MEMBERSHIP_CONFLICT:
    "This account already has different access to this carrier. Ask your dispatcher to review it.",
  DRIVER_ALREADY_ADDED:
    "A driver with this email is already listed. Use their existing invite or account.",
  DRIVER_DETAILS_REQUIRED: "Enter the driver's name and email.",
  COMPANY_DETAILS_REQUIRED:
    "Save the carrier's contact details before creating an invitation.",
  INVALID_AGREEMENT_DATES:
    "The agreement end date must be on or after its start date.",
  PASSWORD_REQUIRED: "Choose a password with at least 12 characters.",
  VERSION_CONFLICT:
    "Someone updated this load. Refresh its details to review the latest version before retrying.",
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  SERVICE_UNAVAILABLE: "The workspace is unavailable. Please retry.",
  CARRIER_AUTHORIZATION_REQUIRED:
    "This carrier needs a verified, current dispatch agreement before booking or assignment.",
  DUPLICATE_REFERENCE: "This carrier already has a load with that reference.",
  ASSIGN_DRIVER_FIRST: "Assign an authorized driver before dispatching.",
  VALIDATION_ERROR:
    "Check the required fields, dates, time zones and text limits before retrying.",
  TRY_AGAIN_LATER: "Too many sign-in attempts. Please try again in one minute.",
  NOT_FOUND: "This load is unavailable or outside your access.",
  AUTH_REQUIRED: "Please sign in to continue.",
  SESSION_EXPIRED: "Your session expired. Sign in again to continue.",
  INVALID_CURSOR: "This queue has changed. Refresh the view.",
  DRIVER_CARRIER_MISMATCH: "Choose a driver authorized by this carrier.",
  CHECK_IN_TIME_OUT_OF_RANGE:
    "Use an observed time within the last 30 days and no more than five minutes ahead.",
  FILE_REQUIRED: "Choose a file to upload.",
  FILE_TOO_LARGE: "Files must be 25 MB or smaller. Compress or split the scan.",
  UNSUPPORTED_FILE_TYPE: "Upload a PDF, PNG or JPEG file.",
  INVALID_UPLOAD: "The upload could not be read. Choose the file again.",
  DUPLICATE_DOCUMENT_VERSION:
    "This exact file is already the current version. No new version was added.",
  DOCUMENT_SUPERSEDED:
    "A newer version was uploaded. Refresh to review the latest file.",
  DISPATCHER_REVIEW_REQUIRED: "Only a dispatcher can review this document.",
  DOCUMENT_UNAVAILABLE:
    "The file could not be retrieved. Its record is retained; please retry.",
  AGREEMENT_FILE_UNAVAILABLE:
    "Upload the signed agreement again; the selected file is no longer current.",
  OWNER_NOT_ELIGIBLE:
    "Choose a dispatcher or carrier manager who works with this carrier.",
  EXCEPTION_RESOLVED: "This exception is already resolved. Reopen it first.",
  INVALID_TRANSITION:
    "That change is not allowed from the current status. Refresh and retry.",
  ROLE_NOT_PERMITTED: "Your role cannot make this change.",
  PACKET_SUBMITTED: "This billing packet was already submitted.",
  PACKET_REQUIRED: "Save the carrier billing packet first.",
  PACKET_NOT_SUBMITTED: "Mark the packet submitted before recording receipts.",
  LOAD_NOT_DELIVERED: "Record delivery before billing this load.",
  DOCUMENTS_NOT_READY:
    "Rate confirmation, BOL and POD must all be accepted before submitting.",
  PAYMENT_EXCEEDS_BALANCE: "That amount exceeds the remaining balance.",
  DISPATCHER_REQUIRED: "Only a dispatcher can manage Relay invoices.",
  LOAD_ALREADY_INVOICED:
    "A selected load is already on an active dispatch invoice.",
  INVOICE_VOID: "This invoice was voided.",
  INVOICE_HAS_PAYMENTS: "Invoices with recorded payments cannot be voided.",
  INVOICE_NOT_ISSUED: "Issue the invoice before recording payments.",
  TOKEN_UNAVAILABLE:
    "This link has expired or was already used. Request a new one.",
  MFA_UNAVAILABLE:
    "Two-step verification is not configured on this server yet. Ask your administrator.",
  MFA_ALREADY_ENABLED: "Two-step verification is already on.",
  MFA_SETUP_REQUIRED: "Start setup again to get a new key.",
  MFA_NOT_ENABLED: "Two-step verification is not on.",
  INVALID_MFA_CODE:
    "That code didn't match. Use the current 6-digit code or an unused recovery code.",
  MFA_CHALLENGE_EXPIRED: "Sign-in timed out. Enter your password again.",
  CANNOT_REMOVE_SELF: "You can't remove your own access.",
  LAST_DISPATCHER: "Each carrier needs at least one dispatcher.",
  DRIVER_HAS_ACTIVE_LOADS:
    "Reassign this driver's undelivered loads before removing them.",
  JOBS_NOT_CONFIGURED: "Scheduled jobs are not configured.",
  DEMO_UNAVAILABLE:
    "Not available in the demo: it has no real accounts. Sign in to Relay to use account security.",
  MALWARE_DETECTED:
    "This file was flagged by the malware scanner and was not stored. Use a clean copy from the original source.",
  SCAN_UNAVAILABLE:
    "Malware scanning is unavailable right now, so the file was not stored. Retry in a few minutes.",
  STORAGE_UNAVAILABLE:
    "Document storage is unavailable right now, so the file was not stored. Retry in a few minutes.",
  CHECK_IN_RETRACTED: "This check-in was retracted and can't be changed.",
  STOP_EVENT_EXISTS:
    "This time is already recorded. Use Correct to change it with a reason.",
  STOP_EVENT_CHANGED:
    "Someone updated this stop. Refresh the load details and review the latest time.",
  STOP_ARRIVAL_REQUIRED:
    "Record the arrival at this stop before its departure.",
  STOP_TIME_ORDER:
    "That time would run backwards along the route. Check this stop's arrival/departure and the neighbouring stops.",
  STOP_TIME_OUT_OF_RANGE:
    "Use a time within the last 30 days and no more than five minutes ahead.",
  DIRECT_UPLOAD_UNAVAILABLE:
    "Files over 4 MB need document storage (an S3-compatible bucket) to be configured. Compress the file or ask your administrator.",
  UPLOAD_NOT_RECEIVED:
    "The file didn't reach storage. Check your connection and retry the upload.",
  UPLOAD_SIZE_MISMATCH:
    "The stored file doesn't match the selected file's size. Choose the file again.",
  UPLOAD_CHECKSUM_MISMATCH:
    "The stored file doesn't match the selected file. Choose the file again.",
  UPLOAD_EXPIRED: "This upload expired. Choose the file again to restart it.",
  OWNER_REQUIRED: "Only an organization owner can do that.",
  ALREADY_MEMBER: "This person already has that access.",
  CARRIER_NOT_IN_ORGANIZATION: "Choose carriers from this organization.",
  OWNER_NOT_REMOVABLE: "Owners can't be removed here.",
  RECIPIENT_CHANNEL_UNAVAILABLE:
    "Some recipients can't receive this kind of message (no account, email address, or text consent). Choose another channel or remove them.",
  SMS_UNAVAILABLE:
    "Text messaging isn't set up on this server. Log a text you sent from your phone instead.",
  THREAD_SCOPE_UNKNOWN: "Choose a carrier or load for this conversation.",
  LOG_TIME_OUT_OF_RANGE:
    "Use a time within the last 90 days and no more than five minutes ahead.",
  ATTACHMENTS_NOT_SUPPORTED:
    "Files can be attached to Relay messages and logged entries only, not to texts or email.",
  TOO_MANY_FILES: "Attach up to three files per message.",
  TOO_MANY_ATTACHMENTS:
    "Too many unsent attachments today. Send or remove some first.",
  LOAD_CANCELLED: "This load was cancelled, so it can't be changed.",
  LOAD_LOCKED: "Delivered loads can't be edited.",
  REASON_REQUIRED: "Add a reason; this load has already been dispatched.",
  NO_CHANGES: "Nothing was changed.",
  STOP_ALREADY_STARTED:
    "A stop with a recorded arrival or departure can't be changed.",
  INVALID_STOP_WINDOWS:
    "Appointment windows must end after they start and stay in order.",
  REFERENCE_TAKEN: "This carrier already has a load with that reference.",
  CANNOT_CANCEL_STARTED:
    "Loads already picked up can't be cancelled. Open an exception instead.",
  DELIVERY_CHANGED:
    "This text changed since you opened it. Refresh and check its status first.",
  ALREADY_SENT: "That text was already sent.",
  DELIVERY_IN_PROGRESS: "That text is still being sent. Check again shortly.",
  CONFIRM_UNKNOWN_REQUIRED:
    "Confirm the earlier text didn't arrive before sending it again.",
  IDEMPOTENCY_CONFLICT:
    "This retry differs from the original request. Refresh the details before recording a new report.",
};
export class ApiError extends Error {
  constructor(
    public status: number,
    code: string,
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  key?: string,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    const form = body instanceof FormData;
    response = await fetch("/api/" + path, {
      method: body ? "POST" : "GET",
      headers: body
        ? {
            ...(form ? {} : { "Content-Type": "application/json" }),
            ...(key ? { "Idempotency-Key": key } : {}),
          }
        : {},
      body: form ? body : body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new ApiError(503, "SERVICE_UNAVAILABLE");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status === 401 ? 401 : 503,
      response.status === 401 ? "SESSION_EXPIRED" : "SERVICE_UNAVAILABLE",
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof data?.error === "string" ? data.error : "SERVICE_UNAVAILABLE",
    );
  return data as T;
}
export function describe(error: string) {
  return messages[error] || error;
}
export const ApiContext = createContext<typeof api>(api);
export function useApi() {
  return useContext(ApiContext);
}
