import { getUpload } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const GET = route<{ id: string }>(async ({ auth, params }) => getUpload(requireCtx(auth), params.id));
