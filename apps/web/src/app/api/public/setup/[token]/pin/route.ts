import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveShare, verifySharePin } from "@dentosim/server";
import { body, route } from "@/lib/api";

export const POST = route<{ token: string }>(async ({ req, params, ip }) => {
  const { pin } = await body(req, z.object({ pin: z.string().max(12) }));
  const grant = await verifySharePin(params.token, pin, ip);
  const s = await resolveShare(params.token, ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(`ds_pin_${s.linkId}`, grant, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 12 * 3600 });
  return res;
}, { public: true });
