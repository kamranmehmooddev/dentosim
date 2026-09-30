import { AppError, checkPinGrant, packageUrls, recordShareView, resolveShare } from "@dentosim/server";
import { route } from "@/lib/api";

/** Patient viewer: signed package URLs for a share token (PIN grant cookie when a PIN is set). */
export const GET = route<{ token: string }>(async ({ req, params, ip }) => {
  const s = await resolveShare(params.token, ip);
  if (s.pinRequired && !checkPinGrant(s.linkId, req.cookies.get(`ds_pin_${s.linkId}`)?.value)) throw new AppError(401, "PIN_REQUIRED", "Enter the PIN from your practice.");
  const urls = await packageUrls(s.orgId, s.revisionId);
  if (req.nextUrl.searchParams.get("refresh") !== "1") await recordShareView(s, ip);
  return urls;
}, { public: true });
