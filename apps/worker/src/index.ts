/**
 * DentoSim processing worker.
 *
 *  - consumes the "process-revision" queue (concurrency WORKER_CONCURRENCY);
 *    each job runs the pipeline in a sandboxed child process
 *  - maintenance: retention (daily), usage reporting to Stripe (hourly),
 *    reaper for jobs stuck in "running" (every 10 min)
 *  - WORKER_SELFCHECK=1 runs every fixture through the pipeline at start-up and
 *    refuses to start if any fails (same code path as CLI and tests)
 */
import { resolve } from "node:path";
import { Worker, UnrecoverableError } from "bullmq";
import { and, eq, lt } from "drizzle-orm";
import { runSelfCheck } from "@dentosim/pipeline";
import {
  MAINTENANCE_QUEUE, PROCESS_QUEUE, captureError, closeDb, closeQueues, closeRedis, config, enforceRetention, initTelemetry, jobs,
  maintenance, redis, reportPendingUsage, retryRevision, withSystem, type ProcessJobData,
} from "@dentosim/server";
import { runProcessingJob } from "@dentosim/server/processing";

async function reapStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - config().WORKER_TIMEOUT_S * 2 * 1000);
  const stuck = await withSystem((tx) => tx.select().from(jobs).where(and(eq(jobs.status, "running"), lt(jobs.startedAt, cutoff))));
  for (const j of stuck) {
    await withSystem((tx) => tx.update(jobs).set({ status: "failed", errorCode: "STALLED", error: "The worker stopped responding.", finishedAt: new Date() }).where(eq(jobs.id, j.id)));
    if (j.attempts < 3) await retryRevision(null, j.revisionId, j.orgId).catch((e) => captureError(e));
  }
  return stuck.length;
}

async function main() {
  initTelemetry("worker");
  const c = config();
  if (process.env.WORKER_SELFCHECK === "1") {
    const results = await runSelfCheck({ fixturesDir: resolve(process.env.FIXTURES_DIR ?? "fixtures"), workDir: resolve(".selfcheck-worker") });
    const failed = results.filter((r) => !r.ok);
    console.log(`[worker] self-check: ${results.length - failed.length}/${results.length} fixture runs passed`);
    if (failed.length) {
      for (const f of failed) console.error(`  FAIL ${f.fixture} › ${f.run}: ${f.failures.join("; ")}`);
      process.exit(1);
    }
  }

  const worker = new Worker<ProcessJobData>(
    PROCESS_QUEUE,
    async (job) => {
      const outcome = await runProcessingJob(job.data);
      if (outcome === "failed") throw new UnrecoverableError("processing failed (reason stored on the revision)");
      return outcome;
    },
    { connection: redis(), concurrency: c.WORKER_CONCURRENCY, lockDuration: 120_000 },
  );
  worker.on("failed", (job, err) => {
    if (!(err instanceof UnrecoverableError)) captureError(err, { jobId: job?.data.jobId ?? "" });
  });

  const maint = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === "retention") return { deleted: await enforceRetention() };
      if (job.name === "usage") return { reported: await reportPendingUsage() };
      if (job.name === "reaper") return { reaped: await reapStuckJobs() };
    },
    { connection: redis(), concurrency: 1 },
  );
  const q = maintenance();
  await q.upsertJobScheduler("retention", { pattern: "17 3 * * *" }, { name: "retention" });
  await q.upsertJobScheduler("usage", { every: 3600_000 }, { name: "usage" });
  await q.upsertJobScheduler("reaper", { every: 600_000 }, { name: "reaper" });

  console.log(`[worker] ready (concurrency ${c.WORKER_CONCURRENCY}, ${c.WORKER_MEMORY_MB} MB / ${c.WORKER_TIMEOUT_S} s per job)`);
  const shutdown = async () => {
    console.log("[worker] shutting down");
    await worker.close();
    await maint.close();
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
