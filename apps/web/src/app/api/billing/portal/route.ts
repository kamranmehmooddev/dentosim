import { createPortal } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const POST = route(async ({ auth }) => ({ url: await createPortal(requireCtx(auth)) }));
