import { z } from "zod";
import { disableTotp } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route(async ({ req, auth }) => {
  const ctx = requireCtx(auth);
  const b = await body(req, z.object({ password: z.string().min(1), code: z.string().min(6).max(8) }));
  await disableTotp(ctx.user.id, b.password, b.code);
  return { ok: true };
});
