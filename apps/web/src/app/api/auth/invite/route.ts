import { NextResponse } from "next/server";
import { z } from "zod";
import { acceptInvitation } from "@dentosim/server";
import { body, route, sessionCookie } from "@/lib/api";

export const POST = route(async ({ req }) => {
  const b = await body(req, z.object({ token: z.string().min(10), name: z.string().max(120).optional(), password: z.string().min(1).max(256) }));
  const session = await acceptInvitation(b.token, b);
  return sessionCookie(NextResponse.json({ ok: true }), session, req);
});
