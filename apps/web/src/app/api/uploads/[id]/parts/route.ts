import { z } from "zod";
import { partUrls } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ req, auth, params }) => {
  const b = await body(req, z.object({ fileIndex: z.number().int().nonnegative(), partNumbers: z.array(z.number().int().positive()).min(1).max(100) }));
  return { urls: await partUrls(requireCtx(auth), params.id, b.fileIndex, b.partNumbers) };
});
