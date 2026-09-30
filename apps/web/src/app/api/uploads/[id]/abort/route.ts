import { abortUpload } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => {
  await abortUpload(requireCtx(auth), params.id);
  return { ok: true };
});
