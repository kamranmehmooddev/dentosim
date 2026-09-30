import { z } from "zod";
import { AppError, completeMfa, SESSION_COOKIE } from "@dentosim/server";
import { body, route } from "@/lib/api";

export const POST = route(async ({ req, ip }) => {
  const { code } = await body(req, z.object({ code: z.string().min(6).max(8) }));
  const t = req.cookies.get(SESSION_COOKIE)?.value;
  if (!t) throw new AppError(401, "UNAUTHORIZED", "Please sign in again.");
  await completeMfa(t, code, ip);
  return { ok: true };
});
