import { NextResponse } from "next/server";
import { audit, destroySession, SESSION_COOKIE } from "@dentosim/server";
import { route, sessionCookie } from "@/lib/api";

export const POST = route(async ({ req, auth }) => {
  const t = req.cookies.get(SESSION_COOKIE)?.value;
  if (auth?.impersonatorUserId) {
    await audit({ orgId: auth.org?.id, actorType: "platform_admin", actorUserId: auth.user.id, impersonatorUserId: auth.impersonatorUserId, action: "admin.impersonation_ended" });
    if (t) await destroySession(t);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("ds_admin_session", "", { path: "/", maxAge: 0 });
  return sessionCookie(res, req.cookies.get("ds_admin_session")?.value ?? null, req);
});
