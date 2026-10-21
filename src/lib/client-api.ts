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
  FILE_TOO_LARGE: "Files must be 4 MB or smaller. Compress or split the scan.",
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
