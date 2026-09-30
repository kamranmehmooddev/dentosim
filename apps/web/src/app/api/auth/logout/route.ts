import { NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@dentosim/server";
import { route, sessionCookie } from "@/lib/api";

export const POST = route(async ({ req }) => {
  const t = req.cookies.get(SESSION_COOKIE)?.value;
  if (t) await destroySession(t);
  return sessionCookie(NextResponse.json({ ok: true }), null, req);
});
