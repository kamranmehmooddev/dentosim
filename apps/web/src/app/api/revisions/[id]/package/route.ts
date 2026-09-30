import { packageUrls } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

/** Short-lived signed URLs for the viewer (never the original upload). */
export const GET = route<{ id: string }>(async ({ auth, params }) => {
  const ctx = requireCtx(auth);
  return packageUrls(ctx.org.id, params.id, { ctx });
});
