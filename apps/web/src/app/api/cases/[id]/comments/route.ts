import { z } from "zod";
import { addComment } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ req, auth, params }) => {
  const b = await body(req, z.object({ body: z.string().min(1).max(5000), revisionId: z.string().uuid().nullish() }));
  const c = await addComment(requireCtx(auth), params.id, b.body, b.revisionId);
  return { id: c.id };
});
