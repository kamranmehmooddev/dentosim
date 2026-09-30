import { completeUpload } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => completeUpload(requireCtx(auth), params.id));
