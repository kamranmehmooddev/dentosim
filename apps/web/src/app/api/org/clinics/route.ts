import { z } from "zod";
import { createClinic, listClinics } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const GET = route(async ({ auth }) => listClinics(requireCtx(auth).org.id));
export const POST = route(async ({ req, auth }) => {
  const { name } = await body(req, z.object({ name: z.string().min(1).max(120) }));
  return createClinic(requireCtx(auth), name);
});
