import { sendToDoctor } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => {
  await sendToDoctor(requireCtx(auth), params.id);
  return { ok: true };
});
