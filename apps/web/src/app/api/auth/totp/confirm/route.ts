import { z } from "zod";
import { confirmTotpSetup } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route(async ({ req, auth }) => {
  const ctx = requireCtx(auth);
  const { code } = await body(req, z.object({ code: z.string().min(6).max(8) }));
  await confirmTotpSetup(ctx.user.id, code);
  return { ok: true };
});
