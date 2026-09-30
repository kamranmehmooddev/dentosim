import { z } from "zod";
import { inviteMember, listMembers } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const GET = route(async ({ auth }) => listMembers(requireCtx(auth).org.id));

export const POST = route(async ({ req, auth }) => {
  const b = await body(req, z.object({ email: z.string().email(), role: z.enum(["admin", "technician", "doctor"]) }));
  await inviteMember(requireCtx(auth), b.email, b.role);
  return { ok: true };
});
