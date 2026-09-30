import { removeDomain } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const DELETE = route<{ id: string }>(async ({ auth, params }) => {
  await removeDomain(requireCtx(auth), params.id);
  return { ok: true };
});
