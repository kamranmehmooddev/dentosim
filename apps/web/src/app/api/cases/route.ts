import { z } from "zod";
import { createCase, listCases } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

export const GET = route(async ({ req, auth }) => {
  const ctx = requireCtx(auth);
  const q = req.nextUrl.searchParams;
  return listCases(ctx, { q: q.get("q") ?? undefined, status: q.get("status") ?? undefined, software: q.get("software") ?? undefined });
});

export const POST = route(async ({ req, auth }) => {
  const ctx = requireCtx(auth);
  const b = await body(req, z.object({
    patientReference: z.string().min(1).max(64),
    patientDisplayName: z.string().max(80).optional(),
    doctorUserId: z.string().uuid().nullish(),
    clinicId: z.string().uuid().nullish(),
  }));
  const c = await createCase(ctx, b);
  return { id: c.id, caseNumber: c.caseNumber };
});
