import { storage, tenantKey } from "@dentosim/server";
import { route } from "@/lib/api";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon" };

/** Public branding assets (logo/favicon) — not PHI. */
export const GET = route<{ orgId: string }>(async ({ req, params }) => {
  const kind = req.nextUrl.searchParams.get("kind") === "favicon" ? "favicon" : "logo";
  const ext = req.nextUrl.searchParams.get("ext") ?? "png";
  if (!MIME[ext] || !/^[0-9a-f-]{36}$/.test(params.orgId)) return new Response("not found", { status: 404 });
  try {
    const data = await storage().get(tenantKey(params.orgId, "branding", `${kind}.${ext}`));
    return new Response(new Uint8Array(data), { headers: { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=86400", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}, { public: true });
