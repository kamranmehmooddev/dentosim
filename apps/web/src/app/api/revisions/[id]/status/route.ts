import { jobStatus } from "@dentosim/server";
import { requireCtx, route } from "@/lib/api";

export const GET = route<{ id: string }>(async ({ auth, params }) => {
  const s = await jobStatus(requireCtx(auth), params.id);
  return {
    revisionStatus: s.revisionStatus,
    failureReason: s.failureReason,
    job: s.job && { status: s.job.status, progress: s.job.progress, step: s.job.step, message: s.job.message, error: s.job.error },
  };
});
