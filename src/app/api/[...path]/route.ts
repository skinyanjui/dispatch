import { receiveSmsStatus, receiveEmailStatus } from "@/lib/provider-receipts";
import {
  createExport,
  exportStatus,
  runPendingExports,
} from "@/lib/report-exports";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { reportInvoices } from "@/lib/report-invoices";
import { operationsStatus } from "@/lib/operations";
import { messageCapabilities, messageResult } from "@/lib/messaging";
import { after, NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "@/lib/db";
import {
  session,
  sameOrigin,
  login,
  HttpError,
  digest,
  rememberDays,
  consumeAttempt,
  clientIp,
} from "@/lib/auth";
import {
  createCarrier,
  carrierSetup,
  saveCompany,
  saveAgreement,
  completeSetup,
  inviteManager,
  inviteDriver,
  inspectInvite,
  acceptInvite,
} from "@/lib/onboarding";
import {
  createLoad,
  attentionLoads,
  listLoads,
  detail,
  mutate,
  recordCheckIn,
  auditDenied,
  amendCheckIn,
  recordStopEvent,
  olderCheckIns,
  olderEvents,
} from "@/lib/loads";
import { cancelLoad, editLoad } from "@/lib/load-changes";
import {
  cancelChange,
  decideChange,
  listChanges,
  pendingCount,
  requestPayoutChange,
  requestCarrierErasure,
} from "@/lib/change-control";
import { auditFilters, auditLog } from "@/lib/audit";
import { authorityStatus, checkAuthority } from "@/lib/authority";
import { cashOverview } from "@/lib/billing-cash";
import { readiness } from "@/lib/readiness";
import {
  batchFile,
  createBatch,
  factoringOverview,
  markHandedOff,
  releaseBatchLoads,
  saveFactoringSettings,
  voidBatch,
} from "@/lib/factoring";
import {
  claimPacket,
  createClaim,
  listClaims,
  loadClaims,
  refreshClaim,
  setTerms,
  settleClaim,
  submitClaim,
} from "@/lib/claims";
import {
  createVehicle,
  fleetOverview,
  setVehicleStatus,
  updateVehicle,
} from "@/lib/fleet";
import {
  canSeeJobStatus,
  jobStatus,
  parseScope,
  runNotificationJob,
} from "@/lib/jobs";
import {
  aiStatus,
  checkExtraction,
  dismissExtraction,
  requestExtraction,
  saveAiSettings,
} from "@/lib/extractions";
import {
  uploadDocument,
  createUploadSession,
  finalizeUpload,
  documentContent,
  reviewDocument,
  carrierDocuments,
} from "@/lib/documents";
import { maxDocumentBytes } from "@/lib/compliance";
import {
  archiveTemplate,
  createTemplate,
  decideDraft,
  draftPdf,
  generateDraft,
  listDrafts,
  listTemplates,
  updateTemplate,
} from "@/lib/drafts";
import {
  createView,
  deleteView,
  listViews,
  updateView,
} from "@/lib/saved-views";
import { addNote, listNotes } from "@/lib/load-notes";
import { carrierSummaries } from "@/lib/carrier-summary";
import { loadsCsv, reportOverview } from "@/lib/reports";
import { receiveEmail, receiveSms } from "@/lib/inbound";
import { appOrigin } from "@/lib/notifications";
import { enforceAudience } from "@/lib/policy";
import { attachmentContent, uploadAttachment } from "@/lib/message-attachments";
import {
  accountSummary,
  changePassword,
  completeEmailVerification,
  completeMfaLogin,
  mfaRequired,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  completePasswordReset,
  mfaDisable,
  mfaEnable,
  mfaSetup,
  organization,
  removeTeamMember,
  requestEmailVerification,
  requestPasswordReset,
  saveOrganization,
  saveProfile,
} from "@/lib/account";
import {
  createSavedReply,
  deleteSavedReply,
  getThread,
  listSavedReplies,
  listThreads,
  markRead,
  isThreadAction,
  setThreadState,
  threadCounts,
  sendMessage,
  resendText,
  visibleThread,
  unreadCount,
  updateSavedReply,
} from "@/lib/messaging";
import {
  archiveContact,
  createContact,
  directory,
  setFavorite,
  updateContact,
} from "@/lib/contacts";
import { beginOidc, finishOidc, isProvider, oidcConfigured } from "@/lib/oidc";
import { submitAccessRequest } from "@/lib/access-requests";
import { rateReadStatus, readRateConfirmation } from "@/lib/rate-reads";
import { ask, assistantState, getConversation } from "@/lib/assistant";
import {
  archiveProspect,
  convertProspect,
  createProspect,
  getProspect,
  listProspects,
  logActivity,
  moveProspect,
  updateProspect,
} from "@/lib/prospects";
import {
  inviteStaff,
  listStaffInvites,
  removeOrganizationAdmin,
  revokeStaffInvite,
} from "@/lib/staff";
import {
  deliverDue,
  notificationLog,
  preferences,
  retryNotification,
  savePreference,
} from "@/lib/notifications";
import {
  billingOverview,
  invoiceCarrier,
  changeInvoice,
  createInvoice,
  recordCarrierReceipt,
  recordInvoicePayment,
  savePacket,
  submitPacket,
} from "@/lib/billing";
import {
  listExceptions,
  openException,
  updateException,
} from "@/lib/exceptions";
export const runtime = "nodejs";
// Reading a document with the model can take most of a minute.
export const maxDuration = 60;
/**
 * Without "keep me signed in" the cookie ends with the browser; with it, the
 * cookie lasts as long as the 30-day session (ADR 0034).
 */
function withSession(res: NextResponse, token: string, remember = false) {
  res.cookies.set("relay_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure:
      process.env.COOKIE_SECURE !== "false" &&
      process.env.NODE_ENV === "production",
    path: "/",
    ...(remember ? { maxAge: rememberDays * 86_400 } : {}),
  });
  return res;
}
async function readBody(req: NextRequest, limit: number) {
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
async function readJson(req: NextRequest): Promise<unknown> {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "JSON_REQUIRED");
  return JSON.parse((await readBody(req, 65536)).toString("utf8"));
}
// The byte cap applies before multipart parsing, so oversized uploads stop
// streaming early. 64 KiB allows for form boundaries and metadata fields.
async function readUpload(req: NextRequest) {
  const type = req.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("multipart/form-data"))
    throw new HttpError(415, "MULTIPART_REQUIRED");
  let form: FormData;
  try {
    const body = await readBody(req, maxDocumentBytes + 65536);
    form = await new Response(new Uint8Array(body), {
      headers: { "content-type": type },
    }).formData();
  } catch (e) {
    if (e instanceof HttpError && e.code === "REQUEST_TOO_LARGE")
      throw new HttpError(413, "FILE_TOO_LARGE");
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "INVALID_UPLOAD");
  }
  const fields: Record<string, string> = {};
  let file: { name: string; bytes: Buffer } | null = null;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") fields[name] = value;
    else if (name === "file" && !file)
      file = {
        name: value.name,
        bytes: Buffer.from(await value.arrayBuffer()),
      };
    else throw new HttpError(400, "INVALID_UPLOAD");
  }
  return { fields, file };
}
const socialCookie = "relay_oidc";
const secureCookies = () =>
  process.env.COOKIE_SECURE !== "false" &&
  process.env.NODE_ENV === "production";
async function authRoutes(req: NextRequest, path: string[]) {
  if (path.length === 2 && path[1] === "providers" && req.method === "GET")
    return NextResponse.json(oidcConfigured());
  if (path[1] !== "oidc" || path.length !== 4 || !isProvider(path[2]))
    throw new HttpError(404, "NOT_FOUND");
  const provider = path[2];
  const origin = new URL(req.url).origin;
  const home = (search = "", hash = "") =>
    new URL("/" + search + hash, appOrigin(origin));
  if (path[3] === "start" && req.method === "GET") {
    const remember = req.nextUrl.searchParams.get("remember") === "1";
    try {
      const { url, state } = await beginOidc(provider, remember, origin);
      const res = NextResponse.redirect(url, 303);
      res.cookies.set(socialCookie, state, {
        httpOnly: true,
        // Apple returns by cross-site POST, which a Lax cookie would not join.
        sameSite: secureCookies() ? "none" : "lax",
        secure: secureCookies(),
        path: "/api/auth/oidc",
        maxAge: 600,
      });
      return res;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return NextResponse.redirect(home("?social_error=" + e.code), 303);
    }
  }
  if (path[3] === "callback" && ["GET", "POST"].includes(req.method)) {
    let fields: Record<string, string> = {};
    if (req.method === "POST") {
      const form = await req.formData();
      for (const [k, v] of form.entries())
        if (typeof v === "string") fields[k] = v;
    } else fields = Object.fromEntries(req.nextUrl.searchParams);
    let res: NextResponse;
    try {
      if (fields.error) throw new HttpError(400, "SOCIAL_SIGNIN_CANCELLED");
      const outcome = await finishOidc(
        provider,
        {
          code: fields.code,
          state: fields.state,
          cookieState: req.cookies.get(socialCookie)?.value,
          user: fields.user,
        },
        origin,
      );
      if (outcome.kind === "requested")
        res = NextResponse.redirect(home("?social=requested"), 303);
      else if ("mfa_challenge" in outcome.result)
        res = NextResponse.redirect(
          home("", "#mfa=" + outcome.result.mfa_challenge),
          303,
        );
      else
        res = withSession(
          NextResponse.redirect(home(), 303),
          outcome.result.token,
          outcome.result.remember,
        );
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      res = NextResponse.redirect(home("?social_error=" + e.code), 303);
    }
    res.cookies.set(socialCookie, "", {
      path: "/api/auth/oidc",
      maxAge: 0,
    });
    return res;
  }
  throw new HttpError(404, "NOT_FOUND");
}
async function handle(req: NextRequest) {
  let actor: string | undefined;
  try {
    const path = req.nextUrl.pathname.slice(5).split("/");
    // Liveness and database reachability for load balancers and monitors.
    // Public by design: it returns no data and no error detail.
    if (path.length === 1 && path[0] === "health" && req.method === "GET") {
      try {
        await pool.query("SELECT 1");
      } catch {
        return NextResponse.json(
          { status: "unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json(
        { status: "ok" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Provider webhooks carry no browser origin or session; each verifies its
    // own signature before anything is read or written.
    if (path[0] === "webhooks" && path.length === 2 && req.method === "POST") {
      // The email hook accepts a large body before it can be verified.
      await consumeAttempt("webhook-ip:" + clientIp(req), 300);
      // Email may carry base64 attachments (up to 6 files of 4 MB, encoded).
      const raw = (
        await readBody(req, path[1] === "email" ? 32 * 1024 * 1024 : 262144)
      ).toString("utf8");
      if (path[1] === "sms-status") {
        await receiveSmsStatus(
          raw,
          req.headers.get("x-twilio-signature"),
          appOrigin(new URL(req.url).origin) +
            "/api/webhooks/sms-status" +
            req.nextUrl.search,
        );
        return new NextResponse(null, { status: 204 });
      }
      if (path[1] === "email-status")
        return NextResponse.json(await receiveEmailStatus(raw, req.headers));
      if (path[1] === "sms") {
        await receiveSms(
          raw,
          req.headers.get("x-twilio-signature"),
          appOrigin(new URL(req.url).origin) + "/api/webhooks/sms",
        );
        return new NextResponse("<Response></Response>", {
          headers: { "Content-Type": "text/xml" },
        });
      }
      if (path[1] === "email")
        return NextResponse.json(
          await receiveEmail(raw, req.headers.get("x-relay-signature")),
        );
      throw new HttpError(404, "NOT_FOUND");
    }
    // Google and Apple sign-in (ADR 0034). The Apple callback is a cross-site
    // form POST, so it cannot pass the same-origin check; the state cookie and
    // the single-use state row authenticate it instead.
    if (path[0] === "auth") {
      return await authRoutes(req, path);
    }
    if (req.method === "POST") sameOrigin(req);
    // Unauthenticated endpoints that send mail or run a password hash have no
    // person to budget by, so each address gets its own allowance.
    if (req.method === "POST" && isPublicAction(path))
      await consumeAttempt("public-ip:" + clientIp(req), 40);
    if (path.length === 1 && path[0] === "login" && req.method === "POST") {
      const input = z
        .object({
          email: z.string().trim().max(254).pipe(z.email()),
          password: z.string().min(1).max(256),
          remember: z.boolean().optional(),
        })
        .parse(await readJson(req));
      await consumeAttempt("login-ip:" + clientIp(req), 60);
      const result = await login(
        input.email,
        input.password,
        input.remember === true,
      );
      if ("mfa_challenge" in result)
        return NextResponse.json({
          mfa_required: true,
          challenge: result.mfa_challenge,
        });
      return withSession(
        NextResponse.json({ ok: true }),
        result.token,
        result.remember,
      );
    }
    if (req.method === "POST" && path.join("/") === "login/mfa") {
      await consumeAttempt("login-ip:" + clientIp(req), 60);
      const done = await completeMfaLogin(await readJson(req), req);
      return withSession(
        NextResponse.json({ ok: true }),
        done.token,
        done.remember,
      );
    }
    if (req.method === "POST" && path.join("/") === "access-requests")
      return NextResponse.json(await submitAccessRequest(await readJson(req)), {
        status: 202,
      });
    if (req.method === "POST" && path.join("/") === "password-reset/request")
      return NextResponse.json(
        await requestPasswordReset(
          await readJson(req),
          req.headers.get("origin") || undefined,
        ),
        { status: 202 },
      );
    if (req.method === "POST" && path.join("/") === "password-reset/complete")
      return NextResponse.json(
        await completePasswordReset(await readJson(req)),
      );
    if (
      req.method === "POST" &&
      path.join("/") === "account/verify-email/complete"
    )
      return NextResponse.json(
        await completeEmailVerification(await readJson(req)),
      );
    if (
      path.length === 3 &&
      path[0] === "onboarding" &&
      path[1] === "invitations" &&
      req.method === "POST"
    ) {
      let current;
      try {
        current = await session(req);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 401)) throw e;
      }
      if (path[2] === "inspect")
        return NextResponse.json(
          await inspectInvite(await readJson(req), current),
        );
      if (path[2] === "accept") {
        const accepted = await acceptInvite(await readJson(req), current);
        return withSession(
          NextResponse.json({ ok: true, role: accepted.role }),
          accepted.sessionToken,
        );
      }
    }
    if (
      path.length === 2 &&
      path[0] === "jobs" &&
      path[1] === "notifications" &&
      req.method === "GET"
    ) {
      cronAuthorized(req);
      return NextResponse.json(
        await runNotificationJob(
          parseScope(req.nextUrl.searchParams.get("scope")),
        ),
      );
    }
    const user = await session(req);
    // Per-person budgets (ADR 0049). Reads are not limited; every write shares
    // one budget and calls that can incur provider cost have a smaller one.
    if (req.method !== "GET" && req.method !== "HEAD") {
      await consumeAttempt("write:" + user.id, 240);
      const sub = path.join("/");
      if (
        sub === "assistant/ask" ||
        /^extractions(\/|$)/.test(sub) ||
        /^documents\/[^/]+\/read$/.test(sub)
      )
        await consumeAttempt("ai:" + user.id, 20);
    }
    actor = user.id;
    const mustEnrollMfa = await mfaRequired(user.id);
    if (mustEnrollMfa && !["logout", "me", "account"].includes(path[0]))
      throw new HttpError(403, "MFA_REQUIRED");
    await enforceAudience(user.id, path[0]);
    if (path[0] === "fleet") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await fleetOverview(
            user.id,
            z.uuid().parse(req.nextUrl.searchParams.get("carrier_id")),
          ),
        );
      if (path[1] === "vehicles" && req.method === "POST") {
        if (path.length === 2)
          return NextResponse.json(
            await createVehicle(user.id, await readJson(req)),
            { status: 201 },
          );
        const vehicleId = z.uuid().parse(path[2]);
        if (path.length === 3)
          return NextResponse.json(
            await updateVehicle(user.id, vehicleId, await readJson(req)),
          );
        if (path.length === 4 && path[3] === "status")
          return NextResponse.json(
            await setVehicleStatus(user.id, vehicleId, await readJson(req)),
          );
      }
    }
    if (path[0] === "factoring") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await factoringOverview(
            user.id,
            req.nextUrl.searchParams.get("carrier_id"),
          ),
        );
      if (path.length === 2 && path[1] === "settings" && req.method === "POST")
        return NextResponse.json(
          await saveFactoringSettings(user.id, await readJson(req)),
        );
      if (path.length === 2 && path[1] === "batches" && req.method === "POST")
        return NextResponse.json(
          await createBatch(user.id, await readJson(req)),
          {
            status: 201,
          },
        );
      if (path.length === 4 && path[1] === "batches") {
        const id = z.uuid().parse(path[2]);
        if (path[3] === "file" && req.method === "GET") {
          const file = await batchFile(user.id, id);
          return new NextResponse(file.csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${file.filename}"`,
              "X-Content-Type-Options": "nosniff",
              "X-File-SHA256": file.sha256,
            },
          });
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          if (path[3] === "handoff")
            return NextResponse.json(await markHandedOff(user.id, id, body));
          if (path[3] === "void")
            return NextResponse.json(await voidBatch(user.id, id, body));
          if (path[3] === "release")
            return NextResponse.json(
              await releaseBatchLoads(user.id, id, body),
            );
        }
      }
    }
    if (path[0] === "claims") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listClaims(
            user.id,
            z.uuid().parse(req.nextUrl.searchParams.get("carrier_id")),
          ),
        );
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createClaim(user.id, await readJson(req)),
          {
            status: 201,
          },
        );
      if (path.length === 2 && path[1] === "load" && req.method === "GET")
        return NextResponse.json(
          await loadClaims(
            user.id,
            z.uuid().parse(req.nextUrl.searchParams.get("load_id")),
          ),
        );
      if (path.length === 2 && path[1] === "terms" && req.method === "POST")
        return NextResponse.json(await setTerms(user.id, await readJson(req)));
      if (path.length === 3) {
        const id = z.uuid().parse(path[1]);
        if (path[2] === "packet" && req.method === "GET") {
          const file = await claimPacket(user.id, id);
          return new NextResponse(new Uint8Array(file.bytes), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${file.filename}"`,
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          if (path[2] === "refresh")
            return NextResponse.json(await refreshClaim(user.id, id, body));
          if (path[2] === "submit")
            return NextResponse.json(await submitClaim(user.id, id, body));
          if (path[2] === "outcome")
            return NextResponse.json(await settleClaim(user.id, id, body));
        }
      }
    }
    if (path[0] === "authority") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await authorityStatus(
            user.id,
            z.uuid().parse(req.nextUrl.searchParams.get("carrier_id")),
          ),
        );
      if (path.length === 2 && path[1] === "check" && req.method === "POST")
        return NextResponse.json(
          await checkAuthority(user.id, await readJson(req)),
        );
    }
    if (path[0] === "change-control") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listChanges(
            user.id,
            z.uuid().parse(req.nextUrl.searchParams.get("carrier_id")),
          ),
        );
      if (path.length === 2 && path[1] === "pending" && req.method === "GET")
        return NextResponse.json(await pendingCount(user.id));
      if (
        path.length === 2 &&
        path[1] === "payout-details" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await requestPayoutChange(user.id, await readJson(req)),
          { status: 201 },
        );
      if (
        path.length === 2 &&
        path[1] === "carrier-erasure" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await requestCarrierErasure(user.id, await readJson(req)),
          { status: 201 },
        );
      if (path.length === 3 && req.method === "POST") {
        const id = z.uuid().parse(path[1]);
        if (path[2] === "decision")
          return NextResponse.json(
            await decideChange(user.id, id, await readJson(req)),
          );
        if (path[2] === "cancel")
          return NextResponse.json(await cancelChange(user.id, id));
      }
    }
    if (path[0] === "audit" && req.method === "GET") {
      if (path.length === 1)
        return NextResponse.json(
          await auditLog(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 2 && path[1] === "filters")
        return NextResponse.json(await auditFilters(user.id));
    }
    if (
      path.length === 2 &&
      path[0] === "jobs" &&
      path[1] === "status" &&
      req.method === "GET"
    ) {
      // Not found for everyone but organization owners and admins.
      if (!(await canSeeJobStatus(user.id)))
        throw new HttpError(404, "NOT_FOUND");
      return NextResponse.json({ jobs: await jobStatus() });
    }
    if (path.length === 1 && path[0] === "logout" && req.method === "POST") {
      const t = req.cookies.get("relay_session")?.value;
      if (t)
        await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
          digest(t),
        ]);
      const res = NextResponse.json({ ok: true });
      res.cookies.delete("relay_session");
      return res;
    }
    if (path.join("/") === "operations/status" && req.method === "GET")
      return NextResponse.json(await operationsStatus(user.id));
    if (path.length === 1 && path[0] === "me" && req.method === "GET") {
      const carriers = await pool.query(
        "SELECT c.*,m.role FROM carriers c JOIN memberships m ON m.carrier_id=c.id WHERE m.user_id=$1",
        [user.id],
      );
      const drivers = await pool.query(
        "SELECT d.* FROM drivers d JOIN memberships m ON m.carrier_id=d.carrier_id WHERE m.user_id=$1 AND m.role<>'driver' AND d.onboarding_status='ready'",
        [user.id],
      );
      const organizations = await pool.query(
        `SELECT o.id,o.name,om.role FROM organizations o JOIN organization_members om ON om.organization_id=o.id WHERE om.user_id=$1
        UNION SELECT DISTINCT o.id,o.name,NULL FROM organizations o JOIN carriers c ON c.organization_id=o.id JOIN memberships m ON m.carrier_id=c.id
          WHERE m.user_id=$1 AND m.role='dispatcher' AND NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=o.id AND user_id=$1)
        ORDER BY name`,
        [user.id],
      );
      return NextResponse.json({
        user,
        carriers: carriers.rows,
        drivers: drivers.rows,
        organizations: organizations.rows,
        ...(mustEnrollMfa ? { mfa_required: true } : {}),
      });
    }
    if (path[0] === "onboarding" && path[1] === "carriers") {
      if (path.length === 2 && req.method === "POST")
        return NextResponse.json(
          await createCarrier(user.id, await readJson(req)),
          { status: 201 },
        );
      const id = z.uuid().parse(path[2]);
      if (path.length === 3 && req.method === "GET")
        return NextResponse.json(await carrierSetup(user.id, id));
      if (path.length === 4 && req.method === "POST") {
        if (path[3] === "company")
          return NextResponse.json(
            await saveCompany(user.id, id, await readJson(req)),
          );
        if (path[3] === "agreement")
          return NextResponse.json(
            await saveAgreement(user.id, id, await readJson(req)),
          );
        if (path[3] === "complete")
          return NextResponse.json(await completeSetup(user.id, id));
        if (path[3] === "manager-invite")
          return NextResponse.json(
            await inviteManager(
              user.id,
              id,
              await readJson(req),
              req.headers.get("origin") || undefined,
            ),
            { status: 201 },
          );
        if (path[3] === "drivers")
          return NextResponse.json(
            await inviteDriver(
              user.id,
              id,
              await readJson(req),
              undefined,
              req.headers.get("origin") || undefined,
            ),
            { status: 201 },
          );
      }
      if (
        path.length === 6 &&
        path[3] === "drivers" &&
        path[5] === "invite" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await inviteDriver(
            user.id,
            id,
            await readJson(req),
            z.uuid().parse(path[4]),
            req.headers.get("origin") || undefined,
          ),
          { status: 201 },
        );
    }
    if (path[0] === "documents") {
      if (path.length === 2 && path[1] === "readiness" && req.method === "GET")
        return NextResponse.json(
          await readiness(user.id, req.nextUrl.searchParams.get("carrier_id")),
        );
      if (path.length === 1 && req.method === "POST") {
        const upload = await readUpload(req);
        return NextResponse.json(
          await uploadDocument(user.id, upload.fields, upload.file),
          { status: 201 },
        );
      }
      if (path[1] === "uploads" && req.method === "POST") {
        if (path.length === 2)
          return NextResponse.json(
            await createUploadSession(user.id, await readJson(req)),
            { status: 201 },
          );
        if (path.length === 4 && path[3] === "finalize")
          return NextResponse.json(
            await finalizeUpload(user.id, z.uuid().parse(path[2])),
            { status: 201 },
          );
      }
      const versionId = z.uuid().parse(path[1]);
      if (path.length === 3 && path[2] === "content" && req.method === "GET") {
        const file = await documentContent(user.id, versionId);
        // Object storage: a 60-second signed URL issued only after the same
        // authorization and audit as an inline download.
        if (file.kind === "redirect")
          return NextResponse.redirect(file.url, 302);
        return new NextResponse(new Uint8Array(file.content), {
          headers: {
            "Content-Type": file.content_type,
            "Content-Length": String(file.content.length),
            "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
          },
        });
      }
      if (path.length === 3 && path[2] === "review" && req.method === "POST")
        return NextResponse.json(
          await reviewDocument(user.id, versionId, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "read" && req.method === "POST")
        return NextResponse.json(
          await requestExtraction(
            user.id,
            versionId,
            req.headers.get("idempotency-key") ?? undefined,
          ),
          { status: 201 },
        );
    }
    if (
      path[0] === "extractions" &&
      path.length === 3 &&
      req.method === "POST"
    ) {
      const id = z.uuid().parse(path[1]);
      if (path[2] === "check")
        return NextResponse.json(
          await checkExtraction(user.id, id, await readJson(req)),
        );
      if (path[2] === "dismiss")
        return NextResponse.json(await dismissExtraction(user.id, id));
    }
    if (
      path[0] === "carriers" &&
      path.length === 2 &&
      path[1] === "summary" &&
      req.method === "GET"
    ) {
      const summary = await carrierSummaries(user.id);
      // Drivers have no carrier overview; same answer as Reports.
      if (!summary.carriers.length) {
        const driver = await pool.query(
          "SELECT 1 FROM memberships WHERE user_id=$1 AND role='driver' LIMIT 1",
          [user.id],
        );
        if (driver.rowCount) throw new HttpError(404, "NOT_FOUND");
      }
      return NextResponse.json(summary);
    }
    if (
      path[0] === "carriers" &&
      path.length === 3 &&
      path[2] === "documents" &&
      req.method === "GET"
    )
      return NextResponse.json(
        await carrierDocuments(user.id, z.uuid().parse(path[1])),
      );
    if (
      path.length === 2 &&
      path[0] === "billing" &&
      path[1] === "cash" &&
      req.method === "GET"
    )
      return NextResponse.json(
        await cashOverview(user.id, req.nextUrl.searchParams),
      );
    if (path.length === 1 && path[0] === "billing" && req.method === "GET")
      return NextResponse.json(
        await billingOverview(user.id, req.nextUrl.searchParams),
      );
    if (
      path[0] === "dispatch-invoices" &&
      path.length === 2 &&
      req.method === "GET"
    )
      return NextResponse.json(
        await invoiceCarrier(user.id, z.uuid().parse(path[1])),
      );
    if (path[0] === "dispatch-invoices" && req.method === "POST") {
      if (path.length === 1)
        return NextResponse.json(
          await createInvoice(user.id, await readJson(req)),
          { status: 201 },
        );
      const invoiceId = z.uuid().parse(path[1]);
      if (path.length === 2)
        return NextResponse.json(
          await changeInvoice(user.id, invoiceId, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "payments")
        return NextResponse.json(
          await recordInvoicePayment(user.id, invoiceId, await readJson(req)),
          { status: 201 },
        );
    }
    if (path[0] === "account") {
      const route = path.slice(1).join("/");
      if (route === "" && req.method === "GET")
        return NextResponse.json(await accountSummary(user.id));
      if (route === "sessions" && req.method === "GET")
        return NextResponse.json(
          await listSessions(
            user.id,
            req.cookies.get("relay_session")?.value || "",
          ),
        );
      if (req.method === "POST") {
        if (route === "password")
          return NextResponse.json(
            await changePassword(
              user.id,
              await readJson(req),
              req.cookies.get("relay_session")?.value || "",
            ),
          );
        if (route === "sessions/revoke-others")
          return NextResponse.json(
            await revokeOtherSessions(
              user.id,
              req.cookies.get("relay_session")?.value || "",
            ),
          );
        if (/^sessions\/[^/]+\/revoke$/.test(route))
          return NextResponse.json(
            await revokeSession(
              user.id,
              z.uuid().parse(route.split("/")[1]),
              req.cookies.get("relay_session")?.value || "",
            ),
          );
        if (route === "profile")
          return NextResponse.json(
            await saveProfile(user.id, await readJson(req)),
          );
        if (route === "verify-email/request")
          return NextResponse.json(
            await requestEmailVerification(
              user.id,
              req.headers.get("origin") || undefined,
            ),
          );
        if (route === "mfa/setup")
          return NextResponse.json(await mfaSetup(user.id));
        if (route === "mfa/enable")
          return NextResponse.json(
            await mfaEnable(user.id, await readJson(req)),
          );
        if (route === "mfa/disable")
          return NextResponse.json(
            await mfaDisable(user.id, await readJson(req)),
          );
      }
    }
    if (path[0] === "organizations" && path.length >= 2) {
      const org = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "GET")
        return NextResponse.json(await organization(user.id, org));
      if (path[2] === "invites") {
        if (path.length === 3 && req.method === "GET")
          return NextResponse.json(await listStaffInvites(user.id, org));
        if (path.length === 3 && req.method === "POST")
          return NextResponse.json(
            await inviteStaff(
              user.id,
              org,
              await readJson(req),
              req.headers.get("origin") || undefined,
            ),
            { status: 201 },
          );
        if (path.length === 5 && path[4] === "revoke" && req.method === "POST")
          return NextResponse.json(
            await revokeStaffInvite(user.id, org, z.uuid().parse(path[3])),
          );
      }
      if (
        path.length === 4 &&
        path[2] === "admins" &&
        path[3] === "remove" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await removeOrganizationAdmin(user.id, org, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "profile" && req.method === "POST")
        return NextResponse.json(
          await saveOrganization(user.id, org, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "ai") {
        if (req.method === "GET")
          return NextResponse.json(await aiStatus(user.id, org));
        if (req.method === "POST")
          return NextResponse.json(
            await saveAiSettings(user.id, org, await readJson(req)),
          );
      }
    }
    if (
      path[0] === "carriers" &&
      path.length === 4 &&
      path[2] === "team" &&
      path[3] === "remove" &&
      req.method === "POST"
    )
      return NextResponse.json(
        await removeTeamMember(
          user.id,
          z.uuid().parse(path[1]),
          await readJson(req),
        ),
      );
    if (path[0] === "document-templates") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(await listTemplates(user.id));
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createTemplate(user.id, await readJson(req)),
          { status: 201 },
        );
      const templateId = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "POST")
        return NextResponse.json(
          await updateTemplate(user.id, templateId, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "archive" && req.method === "POST")
        return NextResponse.json(await archiveTemplate(user.id, templateId));
    }
    if (path[0] === "drafts") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listDrafts(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 2 && path[1] === "generate" && req.method === "POST")
        return NextResponse.json(
          await generateDraft(user.id, await readJson(req)),
          { status: 201 },
        );
      const draftId = z.uuid().parse(path[1]);
      if (path.length === 3 && path[2] === "pdf" && req.method === "GET") {
        const file = await draftPdf(user.id, draftId);
        return new NextResponse(new Uint8Array(file.bytes), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${file.filename}"`,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (path.length === 3 && req.method === "POST") {
        if (path[2] === "approve")
          return NextResponse.json(
            await decideDraft(user.id, draftId, "approved"),
          );
        if (path[2] === "discard")
          return NextResponse.json(
            await decideDraft(user.id, draftId, "discarded"),
          );
      }
    }
    if (path[0] === "views") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(await listViews(user.id));
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createView(user.id, await readJson(req)),
          { status: 201 },
        );
      const viewId = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "POST")
        return NextResponse.json(
          await updateView(user.id, viewId, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "delete" && req.method === "POST")
        return NextResponse.json(await deleteView(user.id, viewId));
    }
    if (path[0] === "threads") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listThreads(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 2 && path[1] === "counts" && req.method === "GET")
        return NextResponse.json(await threadCounts(user.id));
      const threadId = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "GET")
        return NextResponse.json(await getThread(user.id, threadId));
      if (path.length === 3 && path[2] === "read" && req.method === "POST")
        return NextResponse.json(await markRead(user.id, threadId));
      if (path.length === 3 && req.method === "POST" && isThreadAction(path[2]))
        return NextResponse.json(
          await setThreadState(user.id, threadId, path[2]),
        );
    }
    if (
      path[0] === "message-deliveries" &&
      path.length === 3 &&
      path[2] === "resend" &&
      req.method === "POST"
    )
      return NextResponse.json(
        await resendText(user.id, z.uuid().parse(path[1]), await readJson(req)),
      );
    if (path.join("/") === "messaging/capabilities" && req.method === "GET")
      return NextResponse.json(messageCapabilities());
    if (
      path[0] === "messages" &&
      path.length === 3 &&
      path[2] === "result" &&
      req.method === "GET"
    )
      return NextResponse.json(
        await messageResult(user.id, z.uuid().parse(path[1])),
      );
    if (path.join("/") === "reports/exports" && req.method === "POST")
      return NextResponse.json(
        await createExport(user.id, await readJson(req)),
        { status: 202 },
      );
    if (
      path[0] === "reports" &&
      path[1] === "exports" &&
      path.length >= 3 &&
      req.method === "GET"
    ) {
      const id = z.uuid().parse(path[2]);
      const download = path.length === 4 && path[3] === "download";
      if (path.length !== 3 && !download) throw new HttpError(404, "NOT_FOUND");
      const job = await exportStatus(user.id, id, download);
      if (download) {
        const stream = Readable.toWeb(
          Readable.from([job.artifact!]).pipe(createGunzip()),
        );
        return new NextResponse(stream as ReadableStream, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${job.filename}"`,
            "X-Relay-Row-Count": String(job.row_count),
            "X-Relay-Export-Complete": "true",
          },
        });
      }
      return NextResponse.json(job);
    }
    if (path[0] === "reports" && req.method === "GET") {
      if (path.length === 2 && path[1] === "invoices")
        return NextResponse.json(
          await reportInvoices(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 1)
        return NextResponse.json(
          await reportOverview(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 2 && path[1] === "loads.csv") {
        const file = await loadsCsv(user.id, req.nextUrl.searchParams);
        return new NextResponse(file.csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${file.filename}"`,
            "X-Content-Type-Options": "nosniff",
            "X-Relay-Row-Count": String(file.row_count),
            "X-Relay-Export-Complete": "true",
          },
        });
      }
    }
    if (path[0] === "message-attachments") {
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await uploadAttachment(user.id, (await readUpload(req)).file),
          { status: 201 },
        );
      if (path.length === 2 && req.method === "GET") {
        const file = await attachmentContent(
          user.id,
          z.uuid().parse(path[1]),
          visibleThread,
        );
        if (file.kind === "redirect")
          return NextResponse.redirect(file.url, 302);
        return new NextResponse(new Uint8Array(file.content), {
          headers: {
            "Content-Type": file.content_type,
            "Content-Length": String(file.content.length),
            "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
          },
        });
      }
    }
    if (path[0] === "messages" && path.length === 1 && req.method === "POST")
      return NextResponse.json(
        await sendMessage(
          user.id,
          await readJson(req),
          req.headers.get("origin") || undefined,
        ),
        { status: 201 },
      );
    if (
      path[0] === "inbox" &&
      path[1] === "unread" &&
      path.length === 2 &&
      req.method === "GET"
    )
      return NextResponse.json(await unreadCount(user.id));
    if (path[0] === "saved-replies") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(await listSavedReplies(user.id));
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createSavedReply(user.id, await readJson(req)),
          { status: 201 },
        );
      const replyId = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "POST")
        return NextResponse.json(
          await updateSavedReply(user.id, replyId, await readJson(req)),
        );
      if (path.length === 3 && path[2] === "delete" && req.method === "POST")
        return NextResponse.json(await deleteSavedReply(user.id, replyId));
    }
    if (path[0] === "contacts") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await directory(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createContact(user.id, await readJson(req)),
          { status: 201 },
        );
      if (path.length === 2 && path[1] === "favorites" && req.method === "POST")
        return NextResponse.json(
          await setFavorite(user.id, await readJson(req)),
        );
      if (path.length >= 2 && req.method === "POST") {
        const contactId = z.uuid().parse(path[1]);
        if (path.length === 2)
          return NextResponse.json(
            await updateContact(user.id, contactId, await readJson(req)),
          );
        if (path.length === 3 && path[2] === "archive")
          return NextResponse.json(
            await archiveContact(user.id, contactId, await readJson(req)),
          );
      }
    }
    if (path[0] === "rate-confirmations") {
      if (path.length === 2 && path[1] === "status" && req.method === "GET")
        return NextResponse.json(
          await rateReadStatus(
            user.id,
            req.nextUrl.searchParams.get("carrier_id") ?? "",
          ),
        );
      if (path.length === 2 && path[1] === "read" && req.method === "POST") {
        const upload = await readUpload(req);
        return NextResponse.json(
          await readRateConfirmation(user.id, upload.fields, upload.file),
        );
      }
    }
    if (path[0] === "assistant") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await assistantState(
            user.id,
            z
              .uuid()
              .optional()
              .parse(
                req.nextUrl.searchParams.get("organization_id") ?? undefined,
              ),
          ),
        );
      if (path.length === 2 && path[1] === "ask" && req.method === "POST")
        return NextResponse.json(
          await ask(
            user.id,
            await readJson(req),
            req.headers.get("idempotency-key") ?? undefined,
          ),
        );
      if (
        path.length === 3 &&
        path[1] === "conversations" &&
        req.method === "GET"
      )
        return NextResponse.json(
          await getConversation(user.id, z.uuid().parse(path[2])),
        );
    }
    if (path[0] === "prospects") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listProspects(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createProspect(user.id, await readJson(req)),
          { status: 201 },
        );
      const prospectId = path.length >= 2 ? z.uuid().parse(path[1]) : "";
      if (path.length === 2 && req.method === "GET")
        return NextResponse.json(await getProspect(user.id, prospectId));
      if (path.length >= 2 && req.method === "POST") {
        const body = await readJson(req);
        if (path.length === 2)
          return NextResponse.json(
            await updateProspect(user.id, prospectId, body),
          );
        if (path[2] === "stage")
          return NextResponse.json(
            await moveProspect(user.id, prospectId, body),
          );
        if (path[2] === "activities")
          return NextResponse.json(
            await logActivity(user.id, prospectId, body),
            { status: 201 },
          );
        if (path[2] === "archive")
          return NextResponse.json(
            await archiveProspect(user.id, prospectId, body),
          );
        if (path[2] === "convert")
          return NextResponse.json(
            await convertProspect(user.id, prospectId, body),
          );
      }
    }
    if (path[0] === "notifications") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(await notificationLog(user.id));
      if (path.length === 2 && path[1] === "preferences")
        return NextResponse.json(
          req.method === "POST"
            ? await savePreference(user.id, await readJson(req))
            : await preferences(user.id),
        );
      if (path.length === 3 && path[2] === "retry" && req.method === "POST")
        return NextResponse.json(
          await retryNotification(user.id, z.uuid().parse(path[1])),
        );
    }
    if (path[0] === "exceptions") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listExceptions(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 2 && req.method === "POST")
        return NextResponse.json(
          await updateException(
            user.id,
            z.uuid().parse(path[1]),
            await readJson(req),
          ),
        );
    }
    if (path[0] === "loads") {
      if (path.length === 2 && path[1] === "attention" && req.method === "GET")
        return NextResponse.json(
          await attentionLoads(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listLoads(user.id, req.nextUrl.searchParams),
        );
      if (path.length === 1 && req.method === "POST")
        return NextResponse.json(
          await createLoad(
            user.id,
            await readJson(req),
            req.headers.get("idempotency-key") || "",
          ),
          { status: 201 },
        );
      const id = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "GET")
        return NextResponse.json(await detail(user.id, id));
      if (
        path.length === 3 &&
        (path[2] === "edit" || path[2] === "cancel") &&
        req.method === "POST"
      )
        return NextResponse.json(
          await (path[2] === "edit" ? editLoad : cancelLoad)(
            user.id,
            id,
            await readJson(req),
            req.headers.get("idempotency-key") ?? undefined,
          ),
        );
      if (path[2] === "billing-packet" && req.method === "POST") {
        if (path.length === 3)
          return NextResponse.json(
            await savePacket(user.id, id, await readJson(req)),
          );
        if (path.length === 4 && path[3] === "submit")
          return NextResponse.json(
            await submitPacket(user.id, id, await readJson(req)),
          );
        if (path.length === 4 && path[3] === "receipts")
          return NextResponse.json(
            await recordCarrierReceipt(user.id, id, await readJson(req)),
            { status: 201 },
          );
      }
      if (
        path.length === 3 &&
        path[2] === "exceptions" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await openException(user.id, id, await readJson(req)),
          { status: 201 },
        );
      if (
        path[2] === "stops" &&
        path.length === 5 &&
        path[4] === "events" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await recordStopEvent(
            user.id,
            id,
            z.uuid().parse(path[3]),
            await readJson(req),
          ),
          { status: 201 },
        );
      if (path[2] === "notes" && path.length === 3) {
        if (req.method === "GET")
          return NextResponse.json(await listNotes(user.id, id));
        if (req.method === "POST")
          return NextResponse.json(
            await addNote(user.id, id, await readJson(req)),
            { status: 201 },
          );
      }
      if (path[2] === "events" && path.length === 3 && req.method === "GET")
        return NextResponse.json(
          await olderEvents(user.id, id, req.nextUrl.searchParams),
        );
      if (path[2] === "check-ins" && path.length === 3 && req.method === "GET")
        return NextResponse.json(
          await olderCheckIns(user.id, id, req.nextUrl.searchParams),
        );
      if (
        path[2] === "check-ins" &&
        path.length === 5 &&
        path[4] === "amend" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await amendCheckIn(
            user.id,
            id,
            z.uuid().parse(path[3]),
            await readJson(req),
          ),
          { status: 201 },
        );
      if (path.length === 3 && path[2] === "check-ins" && req.method === "POST")
        return NextResponse.json(
          await recordCheckIn(user.id, id, await readJson(req)),
          { status: 201 },
        );
      if (
        path.length === 3 &&
        ["assign", "milestones"].includes(path[2]) &&
        req.method === "POST"
      )
        return NextResponse.json(
          await mutate(user.id, id, path[2], await readJson(req)),
        );
    }
    throw new HttpError(404, "NOT_FOUND");
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404 && actor)
        await auditDenied(actor, req.nextUrl.pathname).catch(() =>
          console.error("audit.denied.unavailable"),
        );
      return NextResponse.json({ error: e.code }, { status: e.status });
    }
    if (e instanceof z.ZodError)
      return NextResponse.json(
        { error: "VALIDATION_ERROR", issues: e.issues },
        { status: 400 },
      );
    if (e instanceof SyntaxError)
      return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
    if ((e as { code?: string }).code === "23505")
      return NextResponse.json(
        { error: "DUPLICATE_REFERENCE" },
        { status: 409 },
      );
    console.error("api.failure", {
      kind: e instanceof Error ? e.name : "UnknownError",
      code: (e as { code?: string }).code,
    });
    return NextResponse.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });
  }
}
const publicActions = [
  "access-requests",
  "password-reset/request",
  "password-reset/complete",
  "account/verify-email/complete",
  "onboarding/invitations/inspect",
  "onboarding/invitations/accept",
];
function isPublicAction(path: string[]) {
  return publicActions.includes(path.join("/"));
}
/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
function cronAuthorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16)
    throw new HttpError(503, "JOBS_NOT_CONFIGURED");
  const given = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new HttpError(401, "AUTH_REQUIRED");
}
async function response(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const result = await handle(req);
  result.headers.set("X-Request-Id", requestId);
  if (process.env.VERCEL_GIT_COMMIT_SHA)
    result.headers.set("X-Relay-Revision", process.env.VERCEL_GIT_COMMIT_SHA);
  if (result.status >= 400)
    console.error("api.result", {
      requestId,
      method: req.method,
      route: req.nextUrl.pathname,
      status: result.status,
      duration_ms: Date.now() - started,
    });
  if (
    req.nextUrl.pathname.startsWith("/api/reports/exports") &&
    result.status < 400
  )
    try {
      after(() =>
        runPendingExports(1)
          .then(() => undefined)
          .catch(() => console.error("report.export_worker_unavailable")),
      );
    } catch {
      /* Scripts and test runners use the explicit worker. */
    }
  // Writes may have queued notifications in their transaction; deliver them
  // after responding. The scheduled job retries anything left behind.
  if (req.method === "POST" && result.status < 400)
    try {
      after(() =>
        deliverDue(10).catch(() =>
          console.error("notification.delivery_unavailable"),
        ),
      );
    } catch {
      // Outside a request scope (tests, scripts) delivery is left to the job.
    }
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("Vary", "Cookie");
  if (result.status === 429) result.headers.set("Retry-After", "60");
  return result;
}
export const GET = response;
export const POST = response;
