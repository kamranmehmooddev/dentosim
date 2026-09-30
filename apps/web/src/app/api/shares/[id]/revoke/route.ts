import { revokeShareLink } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => {
  await revokeShareLink(requireCtx(auth), params.id);
  return { ok: true };
});
