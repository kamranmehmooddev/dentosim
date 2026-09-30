import { z } from "zod";
import { recordPart } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ req, auth, params }) => {
  const b = await body(req, z.object({ fileIndex: z.number().int().nonnegative(), partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) }));
  await recordPart(requireCtx(auth), params.id, b.fileIndex, b.partNumber, b.etag);
  return { ok: true };
});
