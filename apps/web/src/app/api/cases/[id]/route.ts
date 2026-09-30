import { z } from "zod";
import { deleteCase, getCaseDetail, updateCase } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

type P = { id: string };

export const GET = route<P>(async ({ auth, params }) => getCaseDetail(requireCtx(auth), params.id));

export const PATCH = route<P>(async ({ req, auth, params }) => {
  const b = await body(req, z.object({ doctorUserId: z.string().uuid().nullish(), clinicId: z.string().uuid().nullish() }));
  await updateCase(requireCtx(auth), params.id, b);
  return { ok: true };
});

export const DELETE = route<P>(async ({ auth, params }) => {
  await deleteCase(requireCtx(auth), params.id);
  return { ok: true };
});
