import { adminRetryJob } from "@dentosim/server";
import { route } from "@/lib/api";

export const POST = route<{ id: string }>(async ({ auth, params }) => ({ jobId: await adminRetryJob(auth, params.id) }));
