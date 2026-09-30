import { removeMember } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const DELETE = route<{ id: string }>(async ({ auth, params }) => {
  await removeMember(requireCtx(auth), params.id);
  return { ok: true };
});
