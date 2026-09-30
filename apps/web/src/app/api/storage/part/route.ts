import { localStorageDriver, verifyLocalSignature } from "@dentosim/server";
import { route } from "@/lib/api";

/** Local storage driver: signed multipart part upload. Responds with the ETag like S3. */
export const PUT = route(async ({ req }) => {
  const q = verifyLocalSignature(req.nextUrl.searchParams, "part");
  if (!req.body) return new Response("empty body", { status: 400 });
  const etag = await localStorageDriver().writePart(q.uploadId, Number(q.part), req.body);
  return new Response(null, { status: 200, headers: { ETag: etag, "Access-Control-Expose-Headers": "ETag" } });
}, { public: true });
