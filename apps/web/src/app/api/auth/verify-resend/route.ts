import { sendVerification } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route(async ({ auth }) => {
  const ctx = requireCtx(auth);
  await sendVerification(ctx.user.id);
  return { ok: true };
});
