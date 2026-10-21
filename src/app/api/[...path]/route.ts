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
async function readJson(req: NextRequest): Promise<unknown> {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "JSON_REQUIRED");
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new HttpError(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
