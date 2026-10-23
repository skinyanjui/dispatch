"use client";
import { createContext, useContext } from "react";
const messages: Record<string, string> = {
  EXPORT_EXPIRED:
    "This export has expired. Prepare a new export with the same filters.",
  EXPORT_STALLED:
    "This export never started, so nothing was produced. Prepare it again.",
  EXPORT_NOT_READY:
    "This export is still being prepared. Check its status before downloading.",
  EMAIL_UNAVAILABLE:
    "Email delivery is not configured. No message was saved or sent. Use Relay messaging or explicitly log an email sent elsewhere.",
  EXPORT_RANGE_TOO_LARGE:
    "This export exceeds 50,000 loads. Use Prepare larger export, or choose a smaller range; no partial file was downloaded.",
  INVITE_UNAVAILABLE:
    "This invitation link has already been used or has expired. Ask whoever invited you for a fresh one, or just sign in if you've already joined.",
  INVITE_SIGN_IN_REQUIRED:
    "Please sign in with the email address this invitation was sent to, and you're in.",
  MEMBERSHIP_CONFLICT:
    "This account already has a different kind of access here. Ask your dispatcher to take a quick look.",
  DRIVER_ALREADY_ADDED:
    "That driver is already on the list. You can use their existing invite or account.",
  DRIVER_DETAILS_REQUIRED:
    "Add the driver's name and email and we're ready to go.",
  COMPANY_DETAILS_REQUIRED:
    "Save the carrier's contact details first, then you can send the invitation.",
  INVALID_AGREEMENT_DATES:
    "The agreement's end date needs to be on or after its start date.",
  PASSWORD_REQUIRED:
    "Pick a password with at least 12 characters. A few random words works great.",
  VERSION_CONFLICT:
    "Someone just updated this. Refresh the page to see the latest, then try again.",
  INVALID_CREDENTIALS:
    "That email and password don't match. Give it another try, or use “Forgot password” and we'll help.",
  SERVICE_UNAVAILABLE:
    "We couldn't reach Relay just now. Check your connection and try again in a moment.",
  CARRIER_AUTHORIZATION_REQUIRED:
    "This carrier needs a current, verified dispatch agreement before loads can be booked or assigned.",
  DUPLICATE_REFERENCE:
    "This carrier already has a load with that reference. Pick a different one.",
  ASSIGN_DRIVER_FIRST: "Assign a driver first, then you can dispatch.",
  VALIDATION_ERROR:
    "Something looks a little off. Please check the highlighted details, dates and lengths, then try again.",
  TRY_AGAIN_LATER:
    "That's a lot of sign-in attempts. Take a breath and try again in a minute.",
  OWNER_NOT_ON_TEAM: "Pick someone who works on your team as the owner.",
  ALREADY_A_CARRIER:
    "This prospect already became a carrier, so its stage can't be changed here.",
  PROSPECT_LOST: "Reopen this prospect before starting carrier setup.",
  CONTACT_NAME_AND_EMAIL_REQUIRED:
    "Add a contact name and email first. Carrier setup needs them.",
  NOT_FOUND: "We couldn't find that, or it isn't available to your account.",
  AUTH_REQUIRED: "Please sign in to continue.",
  SESSION_EXPIRED:
    "For your security you were signed out. Sign in again and you'll pick up right where you left off.",
  INVALID_CURSOR:
    "This list changed while you were looking. Refresh and you'll be right back on track.",
  DUPLICATE_VEHICLE:
    "This carrier already has a vehicle with that name. Choose another unit name.",
  VEHICLE_CARRIER_MISMATCH:
    "Please choose a vehicle that is in service for this carrier.",
  DRIVER_CARRIER_MISMATCH:
    "Please choose a driver who works with this carrier.",
  CHECK_IN_TIME_OUT_OF_RANGE:
    "Please use a time from the last 30 days, and no more than five minutes from now.",
  FILE_REQUIRED: "Choose a file to upload and we'll take it from there.",
  FILE_TOO_LARGE:
    "That file is a bit too big. Files can be up to 25 MB; try compressing it or splitting the scan.",
  UNSUPPORTED_FILE_TYPE:
    "We can take PDF, PNG or JPEG files. Could you try one of those?",
  INVALID_UPLOAD: "We couldn't read that file. Please choose it again.",
  DUPLICATE_DOCUMENT_VERSION:
    "That exact file is already the current version, so nothing needed to change.",
  DOCUMENT_SUPERSEDED:
    "A newer version was uploaded in the meantime. Refresh to see the latest file.",
  DISPATCHER_REVIEW_REQUIRED: "A dispatcher needs to review this document.",
  DOCUMENT_UNAVAILABLE:
    "We couldn't fetch that file just now. It's safe and still on record; please try again.",
  AGREEMENT_FILE_UNAVAILABLE:
    "Please upload the signed agreement once more. The selected file is no longer current.",
  OWNER_NOT_ELIGIBLE:
    "Choose a dispatcher or carrier manager who works with this carrier.",
  EXCEPTION_RESOLVED:
    "This exception is already resolved. Reopen it if you'd like to keep working on it.",
  INVALID_TRANSITION:
    "That step isn't available from where this load is now. Refresh and try again.",
  ROLE_NOT_PERMITTED:
    "That's one for your dispatcher or manager. They can make this change for you.",
  PACKET_SUBMITTED: "This billing packet has already been submitted.",
  PACKET_REQUIRED: "Save the carrier billing packet first, then continue.",
  PACKET_NOT_SUBMITTED:
    "Mark the packet as submitted before recording payments.",
  LOAD_NOT_DELIVERED:
    "Record the delivery first, then this load is ready for billing.",
  DOCUMENTS_NOT_READY:
    "The rate confirmation, BOL and POD all need to be accepted before this can be submitted.",
  PAYMENT_EXCEEDS_BALANCE:
    "That amount is more than the remaining balance. Please double-check it.",
  DISPATCHER_REQUIRED: "Only dispatchers can manage Relay invoices.",
  LOAD_ALREADY_INVOICED:
    "One of those loads is already on an active dispatch invoice.",
  FEE_TOO_SMALL:
    "That fee comes to $0.00 on the selected loads. Use a higher percentage.",
  INVOICE_VOID: "This invoice has been voided.",
  INVOICE_HAS_PAYMENTS:
    "This invoice already has payments recorded, so it can't be voided.",
  INVOICE_NOT_ISSUED: "Issue the invoice first, then you can record payments.",
  TOKEN_UNAVAILABLE:
    "This link has expired or was already used. No worries, you can request a new one.",
  MFA_UNAVAILABLE:
    "Two-step verification isn't switched on for this server yet. Your administrator can set it up.",
  MFA_ALREADY_ENABLED: "Two-step verification is already on. Nice and secure!",
  MFA_SETUP_REQUIRED: "Please start setup again to get a fresh key.",
  MFA_NOT_ENABLED: "Two-step verification isn't on yet.",
  INVALID_MFA_CODE:
    "That code didn't match. Try the current 6-digit code, or one of your unused recovery codes.",
  MFA_CHALLENGE_EXPIRED:
    "That took a little too long. Please enter your password again.",
  CANNOT_REMOVE_SELF:
    "You can't remove your own access, but another admin can do it for you.",
  LAST_DISPATCHER:
    "Every carrier needs at least one dispatcher, so add another before making this change.",
  DRIVER_HAS_ACTIVE_LOADS:
    "Please reassign this driver's undelivered loads first, then you can remove them.",
  JOBS_NOT_CONFIGURED: "Scheduled jobs aren't set up on this server yet.",
  DEMO_UNAVAILABLE:
    "That one isn't available in the demo, since it has no real accounts. Sign in to Relay to try it.",
  MALWARE_DETECTED:
    "Our scanner flagged that file, so we didn't keep it. Please use a clean copy from the original source.",
  SCAN_UNAVAILABLE:
    "Virus scanning is taking a break, so we didn't keep the file. Please try again in a few minutes.",
  STORAGE_UNAVAILABLE:
    "File storage is taking a break, so the file wasn't saved. Please try again in a few minutes.",
  CHECK_IN_RETRACTED: "This check-in was retracted, so it can't be changed.",
  STOP_EVENT_EXISTS:
    "A time is already recorded here. Use Correct to change it and add a short reason.",
  STOP_EVENT_CHANGED:
    "Someone just updated this stop. Refresh the load to see the latest time.",
  STOP_ARRIVAL_REQUIRED:
    "Record the arrival at this stop first, then the departure.",
  STOP_TIME_ORDER:
    "That time would run backwards along the route. Please check this stop's arrival and departure and the stops next to it.",
  STOP_TIME_OUT_OF_RANGE:
    "Please use a time from the last 30 days, and no more than five minutes from now.",
  DIRECT_UPLOAD_UNAVAILABLE:
    "Files over 4 MB need document storage to be switched on. You can compress the file, or ask your administrator to enable it.",
  UPLOAD_NOT_RECEIVED:
    "The file didn't make it to storage. Check your connection and try the upload again.",
  UPLOAD_SIZE_MISMATCH:
    "The saved file doesn't match the one you chose. Please choose it again.",
  UPLOAD_CHECKSUM_MISMATCH:
    "The saved file doesn't match the one you chose. Please choose it again.",
  UPLOAD_EXPIRED: "This upload timed out. Choose the file again to restart it.",
  OWNER_REQUIRED: "Only an organization owner can do that.",
  ALREADY_MEMBER: "They already have this access, so you're all set.",
  CARRIER_NOT_IN_ORGANIZATION: "Please choose carriers from this organization.",
  OWNER_NOT_REMOVABLE: "Owners can't be removed from here.",
  RECIPIENT_CHANNEL_UNAVAILABLE:
    "We can't reach someone that way (they may not have an account, an email address, or agreed to texts). Try another way to reach them, or remove them for now.",
  SMS_UNAVAILABLE:
    "Texting isn't switched on yet. You can send a Relay message or email, or log a text you sent from your phone.",
  THREAD_SCOPE_UNKNOWN:
    "Pick a carrier or a load so we know where this conversation belongs.",
  LOG_TIME_OUT_OF_RANGE:
    "Please use a time from the last 90 days, and no more than five minutes from now.",
  ATTACHMENTS_NOT_SUPPORTED:
    "Files can go with Relay messages and logged entries. Texts and emails can't carry them yet.",
  TOO_MANY_FILES:
    "Three files per message is the limit. You can send the rest in another message.",
  TOO_MANY_ATTACHMENTS:
    "You have a lot of files waiting to be sent today. Send or remove a few first.",
  LOAD_CANCELLED: "This load was cancelled, so it's now read-only.",
  LOAD_LOCKED: "Delivered loads are locked so the record stays accurate.",
  REASON_REQUIRED:
    "Add a short reason. This load is already on the move, and the history will thank you.",
  NO_CHANGES: "Nothing was different, so there was nothing to save.",
  STOP_ALREADY_STARTED:
    "This stop already has an arrival or departure recorded, so it can't be changed.",
  INVALID_STOP_WINDOWS:
    "Each appointment window should end after it starts, and stops should follow in order.",
  REFERENCE_TAKEN:
    "This carrier already has a load with that reference. Pick a different one.",
  CANNOT_CANCEL_STARTED:
    "This load has already been picked up, so it can't be cancelled. Open an exception to flag the issue.",
  DELIVERY_CHANGED:
    "That text changed since you opened it. Refresh and check its status first.",
  ALREADY_SENT: "Good news: that text was already sent.",
  DELIVERY_IN_PROGRESS:
    "That text is still on its way. Check again in a moment.",
  CONFIRM_UNKNOWN_REQUIRED:
    "Please confirm the earlier text didn't arrive before sending it again.",
  AI_NOT_ENABLED:
    "AI reading is off for this organization. An owner or admin can turn it on in Organization settings.",
  SOCIAL_SIGNIN_FAILED:
    "That sign-in didn't complete, so nothing was changed. Try again, or use your email and password.",
  SOCIAL_SIGNIN_CANCELLED: "Sign-in was cancelled, so nothing was changed.",
  SOCIAL_EMAIL_UNVERIFIED:
    "That account's email address isn't verified with the provider, so it can't be used here. Use your email and password instead.",
  PROVIDER_UNAVAILABLE:
    "That sign-in service isn't responding right now. Try again in a moment, or use your email and password.",
  PROVIDER_NOT_CONFIGURED:
    "That sign-in option isn't set up for this workspace.",
  MOVE_ONE_STEP:
    "Loads move one step at a time. Drop it on the next column, or open the load to record the milestone.",
  VIEW_NAME_TAKEN: "You already have a view with that name.",
  NO_ORGANIZATION: "Only members of a dispatch organization can share a view.",
  TEMPLATE_NAME_TAKEN: "You already have a template with that name.",
  UNKNOWN_MERGE_FIELD:
    "That text uses a merge field this kind of template doesn't offer. Use the field buttons.",
  ALREADY_DECIDED: "Someone already reviewed this draft.",
  TERMS_CHANGED:
    "The Terms or Privacy pages were updated while you were filling this in. Reload the page, read them, and send again.",
  ATTACH_FAILED:
    "The load was created, but the rate confirmation couldn't be attached. Press Create again to retry the upload.",
  READ_ALREADY_USED:
    "That rate confirmation already started a load. Start over with the file to create another.",
  ASSISTANT_NOT_ENABLED:
    "The assistant is off for this organization. An owner or admin can turn it on in Organization settings.",
  AI_UNAVAILABLE:
    "AI reading isn't set up on this server yet, so nothing was sent.",
  AI_BUDGET_REACHED:
    "This month's AI limit has been reached. An owner or admin can raise it in Organization settings.",
  TOO_MANY_ATTEMPTS:
    "This file couldn't be read after a few tries. Check the file, or enter the values by hand.",
  NOT_READABLE: "This kind of paperwork isn't read by AI.",
  ALREADY_RUNNING: "This file is already being read. Give it a moment.",
  NOT_READY: "That reading isn't finished yet.",
  IDEMPOTENCY_CONFLICT:
    "That retry doesn't match your original request. Refresh the details and start fresh.",
  REQUEST_TOO_LARGE:
    "That was a bit too much to send at once. Try a smaller amount.",
  INVALID_RANGE:
    "Please choose a start date before the end date, within one year.",
  ORIGIN_REJECTED:
    "That request didn't come from the Relay page. Reload and try again.",
  JSON_REQUIRED: "Something went sideways on our end. Reload and try again.",
  INVALID_JSON: "Something went sideways on our end. Reload and try again.",
};
export class ApiError extends Error {
  constructor(
    public status: number,
    code: string,
    public requestId?: string,
    public retryAfter?: number,
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
      response.headers.get("X-Request-Id") || undefined,
      response.headers.has("Retry-After")
        ? Number(response.headers.get("Retry-After"))
        : undefined,
    );
  return data as T;
}
/**
 * Friendly text for any error. Known codes have hand-written messages; codes
 * we have not seen are never shown raw.
 */
export function describe(error: string) {
  if (messages[error]) return messages[error];
  return /^[A-Z][A-Z0-9_]+$/.test(error)
    ? "Something didn't go as planned. Please try again, and if it keeps happening let us know."
    : error;
}
export const ApiContext = createContext<typeof api>(api);
export function useApi() {
  return useContext(ApiContext);
}
