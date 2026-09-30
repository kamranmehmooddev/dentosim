import { z } from "zod";
import { setRetention } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const POST = route(async ({ req, auth }) => {
  const { days } = await body(req, z.object({ days: z.number().int().nullable() }));
  await setRetention(requireCtx(auth), days);
  return { ok: true };
});
