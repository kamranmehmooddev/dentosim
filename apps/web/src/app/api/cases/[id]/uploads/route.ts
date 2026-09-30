import { z } from "zod";
import { RATE_LIMITS, rateLimit, startUpload } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ req, auth, params }) => {
  const ctx = requireCtx(auth);
  await rateLimit(RATE_LIMITS.upload, ctx.user.id);
  const b = await body(req, z.object({ files: z.array(z.object({ path: z.string().min(1).max(512), size: z.number().int().nonnegative() })).min(1).max(5000) }));
  return startUpload(ctx, params.id, b.files);
});
