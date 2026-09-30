import { NextResponse } from "next/server";
import { z } from "zod";
import { signup } from "@dentosim/server";
import { body, route, sessionCookie } from "@/lib/api";

const Schema = z.object({ orgName: z.string().min(1).max(120), name: z.string().min(1).max(120), email: z.string().email(), password: z.string().min(1).max(256) });

export const POST = route(async ({ req, ip }) => {
  const b = await body(req, Schema);
  const r = await signup({ ...b, ip });
  return sessionCookie(NextResponse.json({ ok: true }), r.token, req);
});
