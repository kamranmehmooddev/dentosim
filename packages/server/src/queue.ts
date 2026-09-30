/** Redis-backed job queues (BullMQ). */
import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const PROCESS_QUEUE = "process-revision";
export const MAINTENANCE_QUEUE = "maintenance";

export interface ProcessJobData {
  jobId: string;
  revisionId: string;
  orgId: string;
}

let processQueue: Queue<ProcessJobData> | undefined;
let maintenanceQueue: Queue | undefined;

export function processingQueue(): Queue<ProcessJobData> {
  processQueue ??= new Queue<ProcessJobData>(PROCESS_QUEUE, {
    connection: redis(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return processQueue;
}

export function maintenance(): Queue {
  maintenanceQueue ??= new Queue(MAINTENANCE_QUEUE, { connection: redis() });
  return maintenanceQueue;
}

export async function enqueueProcessing(data: ProcessJobData): Promise<void> {
  // job id = our jobs.id → enqueueing the same job twice is a no-op
  await processingQueue().add("process", data, { jobId: data.jobId });
}

export async function closeQueues(): Promise<void> {
  await processQueue?.close();
  await maintenanceQueue?.close();
  processQueue = undefined;
  maintenanceQueue = undefined;
}
