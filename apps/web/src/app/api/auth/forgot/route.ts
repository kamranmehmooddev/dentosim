import { z } from "zod";
import { requestPasswordReset } from "@dentosim/server";
import { body, route } from "@/lib/api";

export const POST = route(async ({ req, ip }) => {
  const { email } = await body(req, z.object({ email: z.string().min(3) }));
  await requestPasswordReset(email, ip);
  return { ok: true };
});
