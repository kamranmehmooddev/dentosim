import { z } from "zod";
import { confirmMapping } from "@dentosim/server";
import { body, requireCtx, route } from "@/lib/api";

const Entry = z.object({
  path: z.string(), node: z.string().optional(), role: z.string(), jaw: z.enum(["upper", "lower"]).optional(),
  stageLabel: z.string().optional(), fdi: z.number().int().optional(), partKind: z.string().optional(),
});

export const POST = route<{ id: string }>(async ({ req, auth, params }) => {
  const b = await body(req, z.object({ entries: z.array(Entry).min(1).max(5000), saveTemplate: z.boolean().optional(), templateName: z.string().max(120).optional(), software: z.string().max(120).optional() }));
  const jobId = await confirmMapping(requireCtx(auth), params.id, b);
  return { jobId };
});
