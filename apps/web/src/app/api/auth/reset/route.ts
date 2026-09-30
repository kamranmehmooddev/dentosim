import { z } from "zod";
import { resetPassword } from "@dentosim/server";
import { body, route } from "@/lib/api";

export const POST = route(async ({ req }) => {
  const b = await body(req, z.object({ token: z.string().min(10), password: z.string().min(1).max(256) }));
  await resetPassword(b.token, b.password);
  return { ok: true };
});
