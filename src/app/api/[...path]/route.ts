import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { session, sameOrigin, login, HttpError, digest } from "@/lib/auth";
import {
  createLoad,
  listLoads,
  detail,
  mutate,
  auditDenied,
} from "@/lib/loads";
export const runtime = "nodejs";
const attempts = new Map<string, { count: number; until: number }>();
async function handle(req: NextRequest) {
  let actor: string | undefined;
  try {
    const path = req.nextUrl.pathname.slice(5).split("/");
    if (req.method === "POST") sameOrigin(req);
    if (path[0] === "login" && req.method === "POST") {
      const input = z
        .object({ email: z.email(), password: z.string().min(1).max(256) })
        .parse(await req.json());
      const key = input.email.toLowerCase();
      const a = attempts.get(key);
      if (a && a.until > Date.now() && a.count >= 8)
        throw new HttpError(429, "TRY_AGAIN_LATER");
      attempts.set(key, {
        count: a && a.until > Date.now() ? a.count + 1 : 1,
        until: a && a.until > Date.now() ? a.until : Date.now() + 60000,
      });
      const token = await login(input.email, input.password);
      attempts.delete(key);
      const res = NextResponse.json({ ok: true });
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
    const user = await session(req);
    actor = user.id;
    if (path[0] === "logout" && req.method === "POST") {
      const t = req.cookies.get("relay_session")?.value;
      if (t)
        await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
          digest(t),
        ]);
      const res = NextResponse.json({ ok: true });
      res.cookies.delete("relay_session");
      return res;
    }
    if (path[0] === "me" && req.method === "GET") {
      const carriers = await pool.query(
        "SELECT c.*,m.role FROM carriers c JOIN memberships m ON m.carrier_id=c.id WHERE m.user_id=$1",
        [user.id],
      );
      const drivers = await pool.query(
        "SELECT d.* FROM drivers d JOIN memberships m ON m.carrier_id=d.carrier_id WHERE m.user_id=$1 AND m.role<>'driver'",
        [user.id],
      );
      return NextResponse.json({
        user,
        carriers: carriers.rows,
        drivers: drivers.rows,
      });
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
            await req.json(),
            req.headers.get("idempotency-key") || "",
          ),
          { status: 201 },
        );
      const id = z.uuid().parse(path[1]);
      if (path.length === 2 && req.method === "GET")
        return NextResponse.json(await detail(user.id, id));
      if (
        path.length === 3 &&
        ["assign", "milestones"].includes(path[2]) &&
        req.method === "POST"
      )
        return NextResponse.json(
          await mutate(user.id, id, path[2], await req.json()),
        );
    }
    throw new HttpError(404, "NOT_FOUND");
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404 && actor)
        await auditDenied(actor, req.nextUrl.pathname);
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
export const GET = handle;
export const POST = handle;
