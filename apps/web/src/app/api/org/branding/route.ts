import { z } from "zod";
import { updateBranding } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

const opt = z.string().max(200).optional();
export const POST = route(async ({ req, auth }) => {
  const b = await body(req, z.object({ name: opt, logoUrl: opt, faviconUrl: opt, primaryColor: opt, secondaryColor: opt, fontFamily: opt, gumColor: opt, emailFromName: opt, patientHeadline: opt }));
  return updateBranding(requireCtx(auth), b);
});
