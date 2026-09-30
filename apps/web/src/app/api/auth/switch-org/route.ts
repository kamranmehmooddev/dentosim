import { z } from "zod";
import { AppError, switchOrg } from "@dentosim/server";
import { body, route } from "@/lib/api";

export const POST = route(async ({ req, auth }) => {
  if (!auth) throw new AppError(401, "UNAUTHORIZED", "Please sign in.");
  const { orgId } = await body(req, z.object({ orgId: z.string().uuid() }));
  await switchOrg(auth, orgId);
  return { ok: true };
});
