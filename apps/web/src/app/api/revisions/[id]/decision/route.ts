import { z } from "zod";
import { decide } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ req, auth, params }) => {
  const b = await body(req, z.object({ decision: z.enum(["approved", "changes_requested"]), note: z.string().max(5000).optional() }));
  await decide(requireCtx(auth), params.id, b.decision, b.note);
  return { ok: true };
});
