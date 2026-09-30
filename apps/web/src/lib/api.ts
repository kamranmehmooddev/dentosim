import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { AppError, captureError, getAuth, SESSION_COOKIE, type AuthContext, type OrgCtx } from "@dentosim/server";
import { ZodError, type z } from "zod";

export interface RouteCtx<P> {
  req: NextRequest;
  params: P;
  ip: string;
  auth: AuthContext | null;
}

const ipOf = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";

/**
 * Route handler wrapper: auth lookup, CSRF check (Origin must match Host for
 * state-changing requests with a cookie session), AppError → JSON.
 */
export function route<P = Record<string, string>>(fn: (c: RouteCtx<P>) => Promise<Response | unknown>, opts: { public?: boolean } = {}) {
  return async (req: NextRequest, { params }: { params: Promise<P> }) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !opts.public) {
        const origin = req.headers.get("origin");
        const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
        if (origin && host && new URL(origin).host !== host) throw new AppError(403, "CSRF", "Cross-site request blocked.");
      }
      const auth = await getAuth(req.cookies.get(SESSION_COOKIE)?.value);
      const out = await fn({ req, params: await params, ip: ipOf(req), auth });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), code: "VALIDATION" }, { status: 400 });
      captureError(e as Error, { route: req.nextUrl.pathname.replace(/\/setup\/[^/]+/, "/setup/[token]") });
      return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500 });
    }
  };
}

export function requireCtx(auth: AuthContext | null): OrgCtx {
  if (!auth) throw new AppError(401, "UNAUTHORIZED", "Please sign in.");
  if (!auth.org || !auth.role) throw new AppError(403, "NO_ORG", "You are not a member of an organisation.");
  return auth as OrgCtx;
}

export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new AppError(400, "BAD_JSON", "Invalid request body.");
  }
  return schema.parse(json);
}

export function sessionCookie(res: NextResponse, token: string | null, req: NextRequest): NextResponse {
  const secure = req.nextUrl.protocol === "https:";
  if (token) res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 14 * 24 * 3600 });
  else res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
  return res;
}
