import { AppError, assertTenantKey, storage } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

/** Mapping-screen thumbnail (?key=…) → redirect to a short-lived signed URL. */
export const GET = route<{ id: string }>(async ({ req, auth, params }) => {
  const ctx = requireCtx(auth);
  const key = req.nextUrl.searchParams.get("key") ?? "";
  assertTenantKey(ctx.org.id, key);
  if (!key.includes(`/revisions/${params.id}/mapping-thumbs/`)) throw new AppError(404, "NOT_FOUND", "Not found");
  return Response.redirect(await storage().signedGetUrl(key, 300), 302);
});
