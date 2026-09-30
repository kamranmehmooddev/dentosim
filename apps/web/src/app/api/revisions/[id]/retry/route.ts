import { retryRevision } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => ({ jobId: await retryRevision(requireCtx(auth), params.id) }));
