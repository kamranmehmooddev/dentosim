import { publishRevision } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => {
  await publishRevision(requireCtx(auth), params.id);
  return { ok: true };
});
