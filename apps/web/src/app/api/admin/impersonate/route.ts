import { NextResponse } from "next/server";
import { z } from "zod";
import { impersonate } from "@dentosim/server";
import { body, route, sessionCookie } from "@/lib/api";

export const POST = route(async ({ req, auth }) => {
  const b = await body(req, z.object({ orgId: z.string().uuid(), reason: z.string().min(3).max(200) }));
  const token = await impersonate(auth, b.orgId, b.reason);
  const res = NextResponse.json({ ok: true });
  // remember the admin's own session to return to it
  const own = req.cookies.get("ds_session")?.value;
  if (own) res.cookies.set("ds_admin_session", own, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 3600 });
  return sessionCookie(res, token, req);
});
