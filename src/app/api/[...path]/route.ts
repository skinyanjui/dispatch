import { after, NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "@/lib/db";
import { session, sameOrigin, login, HttpError, digest } from "@/lib/auth";
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
import { loadsCsv, reportOverview } from "@/lib/reports";
import { receiveEmail, receiveSms } from "@/lib/inbound";
import { appOrigin } from "@/lib/notifications";
import {
  attachmentContent,
  cleanupAbandoned,
  uploadAttachment,
} from "@/lib/message-attachments";
import {
  accountSummary,
  changePassword,
  completeEmailVerification,
  completeMfaLogin,
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
  scheduleReminders,
} from "@/lib/notifications";
import {
  billingOverview,
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
function withSession(res: NextResponse, token: string) {
  res.cookies.set("relay_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure:
      process.env.COOKIE_SECURE !== "false" &&
      process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 43200,
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
async function handle(req: NextRequest) {
  let actor: string | undefined;
  try {
    const path = req.nextUrl.pathname.slice(5).split("/");
    // Provider webhooks carry no browser origin or session; each verifies its
    // own signature before anything is read or written.
    if (path[0] === "webhooks" && path.length === 2 && req.method === "POST") {
      // Email may carry base64 attachments (up to 6 files of 4 MB, encoded).
      const raw = (
        await readBody(req, path[1] === "email" ? 32 * 1024 * 1024 : 262144)
      ).toString("utf8");
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
    if (req.method === "POST") sameOrigin(req);
    if (path.length === 1 && path[0] === "login" && req.method === "POST") {
      const input = z
        .object({
          email: z.string().trim().max(254).pipe(z.email()),
          password: z.string().min(1).max(256),
        })
        .parse(await readJson(req));
      const result = await login(input.email, input.password);
      if ("mfa_challenge" in result)
        return NextResponse.json({
          mfa_required: true,
          challenge: result.mfa_challenge,
        });
      return withSession(NextResponse.json({ ok: true }), result.token);
    }
    if (req.method === "POST" && path.join("/") === "login/mfa")
      return withSession(
        NextResponse.json({ ok: true }),
        await completeMfaLogin(await readJson(req)),
      );
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
      const reminders = await scheduleReminders();
      const cleanup = await cleanupAbandoned();
      return NextResponse.json({
        reminders,
        delivery: await deliverDue(50),
        cleanup,
      });
    }
    const user = await session(req);
    actor = user.id;
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
      path.length === 3 &&
      path[2] === "documents" &&
      req.method === "GET"
    )
      return NextResponse.json(
        await carrierDocuments(user.id, z.uuid().parse(path[1])),
      );
    if (path.length === 1 && path[0] === "billing" && req.method === "GET")
      return NextResponse.json(
        await billingOverview(user.id, req.nextUrl.searchParams),
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
      if (req.method === "POST") {
        if (route === "password")
          return NextResponse.json(
            await changePassword(
              user.id,
              await readJson(req),
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
    if (path[0] === "threads") {
      if (path.length === 1 && req.method === "GET")
        return NextResponse.json(
          await listThreads(user.id, req.nextUrl.searchParams),
        );
      const threadId = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "GET")
        return NextResponse.json(await getThread(user.id, threadId));
      if (path.length === 3 && path[2] === "read" && req.method === "POST")
        return NextResponse.json(await markRead(user.id, threadId));
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
    if (path[0] === "reports" && req.method === "GET") {
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
            ...(file.truncated ? { "X-Relay-Truncated": "true" } : {}),
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
    console.error(
      "api.failure",
      e instanceof Error ? e.message : "Unknown error",
    );
    return NextResponse.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });
  }
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
  const result = await handle(req);
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
