import { localStorageDriver, verifyLocalSignature } from "@dentosim/server";
import { route } from "@/lib/api";

/** Local storage driver: signed GET (development / single-node installs). */
export const GET = route(async ({ req }) => {
  const q = verifyLocalSignature(req.nextUrl.searchParams, "get");
  const data = await localStorageDriver().get(q.key);
  const type = q.key.endsWith(".json") ? "application/json" : q.key.endsWith(".png") ? "image/png" : "application/octet-stream";
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=300",
      "Access-Control-Allow-Origin": "*",
      ...(q.dl ? { "Content-Disposition": `attachment; filename="${q.dl.replace(/"/g, "")}"` } : {}),
    },
  });
}, { public: true });
