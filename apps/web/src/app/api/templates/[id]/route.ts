import { deleteTemplate } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const DELETE = route<{ id: string }>(async ({ auth, params }) => {
  await deleteTemplate(requireCtx(auth), params.id);
  return { ok: true };
});
