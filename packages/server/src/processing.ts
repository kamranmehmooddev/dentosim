/**
 * Processing job (executed by the worker): download the upload, run the
 * pipeline in a sandboxed child process (heap + time limits), store the
 * immutable package or the mapping proposal, update states, meter usage,
 * notify. Safe to retry.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "./audit.js";
import { recordCaseProcessed } from "./billing.js";
import { config } from "./config.js";
import { db, withSystem } from "./db/client.js";
import { cases, jobs, mappingTemplates, revisions, uploads, users, type MappingProposalRow, type RevisionSummary } from "./db/schema.js";
import { sendEmail } from "./email.js";
import { orgBranding } from "./orgs.js";
import type { ProcessJobData } from "./queue.js";
import { putDirectory, storage } from "./storage.js";
import { captureError } from "./telemetry.js";

export class NonRetryableError extends Error {}

interface RunnerResult {
  result?: Record<string, any>;
  error?: { code: string; message: string; detail?: string };
}

function runnerPath(): { file: string; execArgv: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = join(here, "sandbox-runner.js");
  if (existsSync(js)) return { file: js, execArgv: [] };
  // development (tsx): run the TypeScript source with the same loader
  return { file: join(here, "sandbox-runner.ts"), execArgv: process.execArgv.filter((a) => !a.startsWith("--max-old-space-size")) };
}

async function runSandbox(args: object, onProgress: (p: { percent: number; step: string; message: string }) => void): Promise<RunnerResult> {
  const c = config();
  const { file, execArgv } = runnerPath();
  const needsTsx = file.endsWith(".ts") && !execArgv.some((a) => a.includes("tsx"));
  const argv = [...execArgv, ...(needsTsx ? ["--import", "tsx"] : []), `--max-old-space-size=${c.WORKER_MEMORY_MB}`, file, JSON.stringify(args)];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
    let buf = "", out: RunnerResult = {}, stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out = { error: { code: "TIMEOUT", message: `Processing took longer than ${c.WORKER_TIMEOUT_S} s and was stopped. Very large exports may need to be split.` } };
    }, c.WORKER_TIMEOUT_S * 1000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.progress) onProgress(msg.progress);
          if (msg.result) out = { result: msg.result };
          if (msg.error) out = { error: msg.error };
        } catch {
          /* ignore non-JSON output */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!out.result && !out.error)
        out = signal === "SIGKILL" || /heap out of memory|allocation failed/i.test(stderr)
          ? { error: { code: "OUT_OF_MEMORY", message: "The export needed more memory than a processing worker allows." } }
          : { error: { code: "INTERNAL", message: "Unexpected processing error.", detail: `exit ${code} ${stderr.slice(-500)}` } };
      resolve(out);
    });
  });
}

export async function runProcessingJob(data: ProcessJobData): Promise<"ready" | "needs_mapping" | "failed"> {
  const { jobId, revisionId, orgId } = data;
  const loaded = await withSystem(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    const [rev] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.orgId, orgId))).limit(1);
    if (!job || !rev) return null;
    const [up] = rev.uploadId ? await tx.select().from(uploads).where(eq(uploads.id, rev.uploadId)).limit(1) : [];
    const [c] = await tx.select().from(cases).where(eq(cases.id, rev.caseId)).limit(1);
    const templates = await tx.select().from(mappingTemplates).where(eq(mappingTemplates.orgId, orgId));
    await tx.update(jobs).set({ status: "running", attempts: sql`${jobs.attempts} + 1`, startedAt: new Date(), step: "download", progress: 0, message: "Downloading upload", error: null, errorCode: null }).where(eq(jobs.id, jobId));
    return { job, rev, up, c, templates };
  });
  if (!loaded) return "failed";
  const { rev, up, c, templates } = loaded;
  const work = await mkdtemp(join(tmpdir(), "dentosim-job-"));
  const setJob = (patch: Partial<typeof jobs.$inferInsert>) => withSystem((tx) => tx.update(jobs).set(patch).where(eq(jobs.id, jobId)));
  const notify = async (template: "case_ready" | "case_needs_mapping" | "case_failed", extra: Record<string, string> = {}) => {
    if (!rev.createdBy) return;
    const [u] = await db().select().from(users).where(eq(users.id, rev.createdBy)).limit(1);
    if (u)
      await sendEmail({
        to: u.email, template, orgId, branding: await orgBranding(orgId),
        vars: { caseNumber: String(c.caseNumber), url: `${config().APP_URL}/cases/${c.id}${template === "case_needs_mapping" ? `/mapping?revision=${rev.id}` : ""}`, ...extra },
      }).catch(() => undefined);
  };
  const t0 = Date.now();
  try {
    if (!up || up.status !== "complete") throw new NonRetryableError("The upload for this revision is incomplete.");
    // 1. download
    const inputDir = join(work, "in");
    let n = 0;
    for (const f of up.files) {
      const rel = f.key.split("/upload/")[1] ?? `${n}`;
      await storage().download(f.key, join(inputDir, rel.split("/").slice(1).join("/") || rel));
      n++;
      if (n % 10 === 0) await setJob({ progress: Math.round((n / up.files.length) * 5), message: `Downloaded ${n}/${up.files.length} files` });
    }
    // 2. sandboxed pipeline
    let lastWrite = 0;
    const outDir = join(work, "out");
    const r = await runSandbox(
      { inputDir, outDir, templates: templates.map((t) => t.template), ...(rev.confirmedMapping ? { manualMapping: rev.confirmedMapping } : {}) },
      (p) => {
        if (Date.now() - lastWrite < 700) return;
        lastWrite = Date.now();
        void setJob({ progress: Math.max(5, p.percent), step: p.step, message: p.message });
      },
    );
    if (r.error) {
      if (r.error.detail) captureError(new Error(`${r.error.code}: ${r.error.detail}`), { jobId });
      const retryable = r.error.code === "INTERNAL";
      await fail(r.error.message, r.error.code);
      if (retryable) throw new Error(r.error.message); // let the queue retry once
      return "failed";
    }
    const res = r.result!;
    if (res.status === "needs-mapping") {
      const thumbPrefix = `orgs/${orgId}/cases/${c.id}/revisions/${rev.id}/mapping-thumbs`;
      await putDirectory(join(outDir, "thumbs"), thumbPrefix).catch(() => []);
      const proposal: MappingProposalRow = {
        entries: (res.proposal.entries as MappingProposalRow["entries"]).map((e) => {
          const t = res.thumbs[e.node !== undefined ? `${e.path}#${e.node}` : e.path];
          return { ...e, ...(t ? { thumbnailKey: `${thumbPrefix}/${t}` } : {}) };
        }),
        reasons: res.reasons,
      };
      await withSystem(async (tx) => {
        await tx.update(revisions).set({ status: "needs_mapping", mappingProposal: proposal, summary: null }).where(eq(revisions.id, rev.id));
        await tx.update(cases).set({ status: "needs_mapping", lastActivityAt: new Date() }).where(eq(cases.id, c.id));
        await tx.update(jobs).set({ status: "needs_mapping", progress: 100, message: "Waiting for file mapping", detection: res.detection, finishedAt: new Date() }).where(eq(jobs.id, jobId));
      });
      await notify("case_needs_mapping");
      return "needs_mapping";
    }
    // 3. store the immutable package
    const pkgPrefix = `orgs/${orgId}/cases/${c.id}/revisions/${rev.id}/package`;
    await setJob({ progress: 98, step: "store", message: "Storing simulation package" });
    await storage().deletePrefix(pkgPrefix + "/"); // a retried job replaces a partial copy
    const stored = await putDirectory(join(outDir, "package"), pkgPrefix);
    const reg = res.registration ?? { performed: false, note: "" };
    const summary: RevisionSummary = {
      stagesPerJaw: res.metadata.stagesPerJaw,
      stageCount: res.metadata.stageCount,
      adapter: res.adapter,
      vendor: res.vendor,
      detection: res.detection,
      warnings: (res.warnings ?? []).map((w: { code: string; severity: string; message: string }) => ({ code: w.code, severity: w.severity, message: w.message })),
      registration: {
        performed: reg.performed, note: reg.note,
        ...(reg.upper ? { upper: { trimmedMeanMm: reg.upper.trimmedMeanMm, medianMm: reg.upper.medianMm } } : {}),
        ...(reg.lower ? { lower: { trimmedMeanMm: reg.lower.trimmedMeanMm, medianMm: reg.lower.medianMm } } : {}),
      },
      segmentation: Object.fromEntries(Object.entries(res.segmentation?.jaws ?? {}).map(([j, s]: [string, any]) => [j, { teeth: s.teeth, attachments: s.attachments, unsegmented: s.unsegmented }])),
      compression: res.metadata.compression,
      normalization: res.normalization,
      packageBytes: stored.reduce((s, f) => s + f.bytes, 0),
      processingMs: Date.now() - t0,
    };
    const templateId: string | undefined = res.mappingApplied?.templateId;
    const manualSoftware = (rev.confirmedMapping as { software?: string } | null)?.software;
    const software = templateId
      ? templates.find((t) => t.id === templateId)?.software ?? res.vendor
      : res.mappingApplied?.manual
        ? manualSoftware ?? "Unknown (mapped manually)"
        : res.vendor === "generic" ? "Generic / unknown" : res.vendor;
    await withSystem(async (tx) => {
      await tx.update(revisions).set({ status: "ready_for_review", packagePrefix: pkgPrefix, summary, failureReason: null }).where(eq(revisions.id, rev.id));
      await tx.update(cases).set({ status: "ready_for_review", sourceSoftware: software, currentRevisionId: rev.id, lastActivityAt: new Date() }).where(eq(cases.id, c.id));
      await tx.update(jobs).set({ status: "succeeded", progress: 100, step: "done", message: "Ready", detection: res.detection, finishedAt: new Date() }).where(eq(jobs.id, jobId));
      if (templateId) await tx.update(mappingTemplates).set({ timesUsed: sql`${mappingTemplates.timesUsed} + 1` }).where(eq(mappingTemplates.id, templateId));
    });
    await recordCaseProcessed(orgId, c.id);
    await audit({ orgId, actorType: "system", action: "revision.processed", targetType: "revision", targetId: rev.id, metadata: { adapter: res.adapter?.name, ms: summary.processingMs } });
    await notify("case_ready");
    return "ready";
  } catch (e) {
    if (e instanceof NonRetryableError) {
      await fail(e.message, "BAD_UPLOAD");
      return "failed";
    }
    const status = await withSystem(async (tx) => (await tx.select({ s: jobs.status }).from(jobs).where(eq(jobs.id, jobId)))[0]?.s);
    if (status === "running") await fail("Unexpected processing error.", "INTERNAL");
    captureError(e as Error, { jobId });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  async function fail(message: string, code: string) {
    await withSystem(async (tx) => {
      await tx.update(revisions).set({ status: "failed", failureReason: message }).where(eq(revisions.id, rev.id));
      await tx.update(cases).set({ status: "failed", lastActivityAt: new Date() }).where(eq(cases.id, c.id));
      await tx.update(jobs).set({ status: "failed", error: message, errorCode: code, finishedAt: new Date() }).where(eq(jobs.id, jobId));
    });
    await notify("case_failed", { reason: message });
  }
}
