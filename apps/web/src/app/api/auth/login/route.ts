import { NextResponse } from "next/server";
import { z } from "zod";
import { login } from "@dentosim/server";
import { body, route, sessionCookie } from "@/lib/api";

const Schema = z.object({ email: z.string().min(1), password: z.string().min(1).max(256) });

export const POST = route(async ({ req, ip }) => {
  const b = await body(req, Schema);
  const r = await login(b.email, b.password, ip);
  return sessionCookie(NextResponse.json({ ok: true, mfaRequired: r.mfaRequired }), r.token, req);
});
