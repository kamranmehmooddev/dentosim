import { AppError, storage, tenantKey, updateBranding } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp", "image/x-icon": "ico" };

/** Upload a logo or favicon (multipart form: file, kind=logo|favicon). Max 1 MB. */
export const POST = route(async ({ req, auth }) => {
  const ctx = requireCtx(auth);
  const form = await req.formData();
  const file = form.get("file");
  const kind = form.get("kind") === "favicon" ? "favicon" : "logo";
  if (!(file instanceof File)) throw new AppError(400, "BAD_REQUEST", "Choose an image.");
  if (file.size > 1024 * 1024) throw new AppError(400, "BAD_REQUEST", "Images must be under 1 MB.");
  const ext = TYPES[file.type];
  if (!ext) throw new AppError(400, "BAD_REQUEST", "Use PNG, JPEG, SVG, WebP or ICO.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  await storage().put(tenantKey(ctx.org.id, "branding", `${kind}.${ext}`), bytes, file.type);
  const url = `/api/branding/${ctx.org.id}/logo?kind=${kind}&ext=${ext}&v=${Date.now()}`;
  await updateBranding(ctx, kind === "logo" ? { logoUrl: url } : { faviconUrl: url });
  return { url };
});
