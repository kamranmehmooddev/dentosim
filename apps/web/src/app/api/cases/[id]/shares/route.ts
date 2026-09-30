import { z } from "zod";
import { createShareLink, listShareLinks } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

type P = { id: string };

export const GET = route<P>(async ({ auth, params }) => listShareLinks(requireCtx(auth), params.id));

export const POST = route<P>(async ({ req, auth }) => {
  const b = await body(req, z.object({
    revisionId: z.string().uuid(),
    expiresAt: z.string().datetime().nullish(),
    pin: z.string().regex(/^\d{4,8}$/).nullish().or(z.literal("")),
    emailTo: z.string().email().nullish().or(z.literal("")),
  }));
  const link = await createShareLink(requireCtx(auth), {
    revisionId: b.revisionId,
    expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
    pin: b.pin || null,
    emailTo: b.emailTo || null,
  });
  return { id: link.id, url: link.url };
});
