/**
 * Upload → process → package, exactly as the web app + worker do it:
 * chunked multipart upload through signed part URLs (local driver),
 * completion, the sandboxed pipeline run, the stored package, needs-mapping
 * with thumbnails, confirmed mapping → saved template → automatic next time.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { generateFixtures } from "@dentosim/pipeline";
import { completeUpload, confirmMapping, createCase, getUpload, packageUrls, partUrls, recordPart, sendToDoctor, startUpload, type OrgCtx } from "../src/cases.js";
import { withSystem } from "../src/db/client.js";
import { cases, jobs, mappingTemplates, revisions, usageRecords } from "../src/db/schema.js";
import { runProcessingJob } from "../src/processing.js";
import { localStorageDriver, storage, verifyLocalSignature } from "../src/storage.js";
import { addMember, newOrg } from "./helpers.js";

const fixtures = resolve(__dirname, "../../../fixtures");
generateFixtures(fixtures);

function filesOf(dir: string): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p), data: new Uint8Array(readFileSync(p)) });
    }
  };
  walk(dir);
  return out;
}

/** What the browser uploader does, against the local driver's signed part URLs. */
async function upload(ctx: OrgCtx, caseId: string, files: { path: string; data: Uint8Array }[]) {
  const up = await startUpload(ctx, caseId, files.map((f) => ({ path: f.path, size: f.data.length })));
  for (const [i, f] of up.files.entries()) {
    const parts = [...Array(f.partCount).keys()].map((k) => k + 1);
    for (const { partNumber, url } of await partUrls(ctx, up.uploadId, i, parts)) {
      const q = verifyLocalSignature(new URL(url).searchParams, "part");
      const chunk = files[i].data.subarray((partNumber - 1) * f.partSize, partNumber * f.partSize);
      const etag = await localStorageDriver().writePart(q.uploadId, partNumber, chunk);
      await recordPart(ctx, up.uploadId, i, partNumber, etag);
    }
  }
  expect((await getUpload(ctx, up.uploadId)).files.every((f) => f.completedParts.length === f.partCount)).toBe(true);
  return { ...up, ...(await completeUpload(ctx, up.uploadId)) };
}

async function runJob(orgId: string, revisionId: string) {
  const [job] = await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.revisionId, revisionId)).orderBy(jobs.createdAt));
  const all = await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.revisionId, revisionId)));
  const latest = all.sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? job;
  return runProcessingJob({ jobId: latest.id, revisionId, orgId });
}

describe("upload → process → package", () => {
  it("processes a zipped numbered-STL export into a signed, immutable package", async () => {
    const o = await newOrg();
    const doc = await addMember(o.orgId, "doctor");
    const c = await createCase(o.ctx, { patientReference: "P-100", doctorUserId: doc.user.id });
    const data = new Uint8Array(readFileSync(join(fixtures, "generic-maxmand-folders/export.zip")));
    const up = await upload(o.ctx, c.id, [{ path: "case.zip", data }]);
    expect(await runJob(o.orgId, up.revisionId)).toBe("ready");
    const [rev] = await withSystem((tx) => tx.select().from(revisions).where(eq(revisions.id, up.revisionId)));
    expect(rev.status).toBe("ready_for_review");
    expect(rev.summary?.stagesPerJaw).toEqual({ upper: 9, lower: 7 });
    expect(rev.summary?.registration.performed).toBe(false);
    const [cs] = await withSystem((tx) => tx.select().from(cases).where(eq(cases.id, c.id)));
    expect(cs.status).toBe("ready_for_review");
    expect(cs.sourceSoftware).toBe("Generic / unknown");
    expect((await withSystem((tx) => tx.select().from(usageRecords).where(eq(usageRecords.caseId, c.id)))).length).toBe(1);
    const urls = await packageUrls(o.orgId, up.revisionId, { ctx: o.ctx });
    expect(Object.keys(urls.files)).toContain("upper/stage-08.tsm2");
    const q = verifyLocalSignature(new URL(urls.files["metadata.json"]).searchParams, "get");
    const meta = JSON.parse(new TextDecoder().decode(await storage().get(q.key)));
    expect(meta.packageFormat).toBe("dentosim-package/1");
    // a foreign tenant cannot get URLs for this package
    const other = await newOrg();
    await expect(packageUrls(other.orgId, up.revisionId, { ctx: other.ctx })).rejects.toThrow(/not found/i);
    await sendToDoctor(o.ctx, up.revisionId);
    const [cs2] = await withSystem((tx) => tx.select().from(cases).where(eq(cases.id, c.id)));
    expect(cs2.status).toBe("doctor_review");
  });

  it("unknown export → needs mapping (with thumbnails) → mapping confirmed → template reused automatically", async () => {
    const o = await newOrg();
    const c = await createCase(o.ctx, { patientReference: "P-200" });
    const up = await upload(o.ctx, c.id, filesOf(join(fixtures, "unknown-needs-mapping/export")));
    expect(await runJob(o.orgId, up.revisionId)).toBe("needs_mapping");
    const [rev] = await withSystem((tx) => tx.select().from(revisions).where(eq(revisions.id, up.revisionId)));
    expect(rev.status).toBe("needs_mapping");
    expect(rev.mappingProposal!.reasons.length).toBeGreaterThan(0);
    const withThumb = rev.mappingProposal!.entries.filter((e) => e.thumbnailKey);
    expect(withThumb.length).toBe(6);
    expect((await storage().get(withThumb[0].thumbnailKey!)).subarray(1, 4)).toEqual(new TextEncoder().encode("PNG"));

    const mapping = JSON.parse(readFileSync(join(fixtures, "unknown-needs-mapping/mapping.json"), "utf8"));
    await confirmMapping(o.ctx, up.revisionId, { ...mapping, saveTemplate: true, templateName: "Acme export", software: "Acme Planner" });
    expect(await runJob(o.orgId, up.revisionId)).toBe("ready");
    expect((await withSystem((tx) => tx.select().from(cases).where(eq(cases.id, c.id))))[0].sourceSoftware).toBe("Acme Planner");

    // next export from the same software: mapped by the saved template, no mapping screen
    const c2 = await createCase(o.ctx, { patientReference: "P-201" });
    const up2 = await upload(o.ctx, c2.id, filesOf(join(fixtures, "unknown-needs-mapping-repeat/export")));
    expect(await runJob(o.orgId, up2.revisionId)).toBe("ready");
    const [t] = await withSystem((tx) => tx.select().from(mappingTemplates).where(eq(mappingTemplates.orgId, o.orgId)));
    expect(t.timesUsed).toBe(1);
    const [rev2] = await withSystem((tx) => tx.select().from(revisions).where(eq(revisions.id, up2.revisionId)));
    expect(rev2.summary!.adapter.name).toBe(`template:${t.id}`);
  });

  it("fails with a human-readable reason for unreadable uploads", async () => {
    const o = await newOrg();
    const c = await createCase(o.ctx, { patientReference: "P-300" });
    const up = await upload(o.ctx, c.id, [{ path: "broken.stl", data: new TextEncoder().encode("not a mesh at all") }]);
    expect(await runJob(o.orgId, up.revisionId)).toBe("failed");
    const [rev] = await withSystem((tx) => tx.select().from(revisions).where(eq(revisions.id, up.revisionId)));
    expect(rev.failureReason).toMatch(/could not be read/);
    const [job] = await withSystem((tx) => tx.select().from(jobs).where(eq(jobs.revisionId, up.revisionId)));
    expect(job.errorCode).toBe("MESH_PARSE");
  });

  it("rejects path traversal in upload names", async () => {
    const o = await newOrg();
    const c = await createCase(o.ctx, { patientReference: "P-400" });
    await expect(startUpload(o.ctx, c.id, [{ path: "../../etc/passwd", size: 10 }])).rejects.toThrow(/'\.\.'/);
  });
});
