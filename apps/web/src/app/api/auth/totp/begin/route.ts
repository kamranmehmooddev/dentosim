import QRCode from "qrcode";
import { beginTotpSetup } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route(async ({ auth }) => {
  const ctx = requireCtx(auth);
  const r = await beginTotpSetup(ctx.user.id);
  return { secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 200 }) };
});
