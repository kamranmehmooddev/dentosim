import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, SESSION_COOKIE, tenantForHost, type AuthContext, type OrgCtx } from "@dentosim/server";

export async function currentAuth(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getAuth(token);
}

/** For pages: redirect to /login when signed out. */
export async function requirePageAuth(): Promise<OrgCtx> {
  const ctx = await currentAuth();
  if (!ctx) redirect("/login");
  if (!ctx.org || !ctx.role) redirect("/login?error=no-org");
  return ctx as OrgCtx;
}

export async function currentTenant() {
  return tenantForHost((await headers()).get("host"));
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "local";
}
