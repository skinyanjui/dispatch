import { NextRequest, NextResponse } from "next/server";
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
  listLoads,
  detail,
  mutate,
  recordCheckIn,
  auditDenied,
} from "@/lib/loads";
import {
  uploadDocument,
  documentContent,
  reviewDocument,
  carrierDocuments,
} from "@/lib/documents";
import { maxDocumentBytes } from "@/lib/compliance";
import {
  listExceptions,
  openException,
  updateException,
} from "@/lib/exceptions";
export const runtime = "nodejs";
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
    if (req.method === "POST") sameOrigin(req);
    if (path.length === 1 && path[0] === "login" && req.method === "POST") {
      const input = z
        .object({
          email: z.string().trim().max(254).pipe(z.email()),
          password: z.string().min(1).max(256),
        })
        .parse(await readJson(req));
      const token = await login(input.email, input.password);
      const res = NextResponse.json({ ok: true });
      return withSession(res, token);
    }
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
        "SELECT DISTINCT o.id,o.name FROM organizations o JOIN carriers c ON c.organization_id=o.id JOIN memberships m ON m.carrier_id=c.id WHERE m.user_id=$1 AND m.role='dispatcher'",
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
            await inviteManager(user.id, id, await readJson(req)),
            { status: 201 },
          );
        if (path[3] === "drivers")
          return NextResponse.json(
            await inviteDriver(user.id, id, await readJson(req)),
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
      const versionId = z.uuid().parse(path[1]);
      if (path.length === 3 && path[2] === "content" && req.method === "GET") {
        const file = await documentContent(user.id, versionId);
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
        path[2] === "exceptions" &&
        req.method === "POST"
      )
        return NextResponse.json(
          await openException(user.id, id, await readJson(req)),
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
async function response(req: NextRequest) {
  const result = await handle(req);
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("Vary", "Cookie");
  if (result.status === 429) result.headers.set("Retry-After", "60");
  return result;
}
export const GET = response;
export const POST = response;
