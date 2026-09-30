import QRCode from "qrcode";
import { AppError, listShareLinks } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

/** QR code PNG for a share link (?case=<caseId>). */
export const GET = route<{ id: string }>(async ({ req, auth, params }) => {
  const ctx = requireCtx(auth);
  const caseId = req.nextUrl.searchParams.get("case") ?? "";
  const link = (await listShareLinks(ctx, caseId)).find((l) => l.id === params.id);
  if (!link) throw new AppError(404, "NOT_FOUND", "Link not found");
  const png = await QRCode.toBuffer(link.url, { width: 512, margin: 2 });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
});
