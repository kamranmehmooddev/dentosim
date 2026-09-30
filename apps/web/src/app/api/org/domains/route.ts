import { z } from "zod";
import { addCustomDomain, listDomains } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const GET = route(async ({ auth }) => listDomains(requireCtx(auth).org.id));

export const POST = route(async ({ req, auth }) => {
  const { hostname } = await body(req, z.object({ hostname: z.string().min(4).max(253) }));
  const d = await addCustomDomain(requireCtx(auth), hostname);
  return { id: d.id, hostname: d.hostname, verificationToken: d.verificationToken };
});
