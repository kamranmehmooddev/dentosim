/**
 * Cases, revisions and uploads.
 *
 * Case states:
 *   UPLOADED → PROCESSING → READY_FOR_REVIEW → DOCTOR_REVIEW → APPROVED → PUBLISHED → PATIENT_VIEWED
 *   DOCTOR_REVIEW → CHANGES_REQUESTED → (new revision) → PROCESSING
 *   PROCESSING → NEEDS_MAPPING → (mapping confirmed) → PROCESSING;  PROCESSING → FAILED (retryable)
 * Every upload creates a new immutable revision; approvals are revision-specific.
 */
import { and, asc, desc, eq, ilike, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { audit } from "./audit.js";
import type { AuthContext, Role } from "./auth.js";
import { assertCanProcess } from "./billing.js";
import { config } from "./config.js";
import { db, withSystem, withTenant, type Tx } from "./db/client.js";
import {
  approvals, cases, comments, jobs, mappingTemplates, organizations, patients, revisions, shareLinks, uploads, users,
  type MappingProposalRow, type UploadFile,
} from "./db/schema.js";
import { sendEmail } from "./email.js";
import { orgBranding } from "./orgs.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { enqueueProcessing } from "./queue.js";
import { assertTenantKey, revisionPrefix, storage, uploadObjectKey } from "./storage.js";

export type OrgCtx = AuthContext & { org: NonNullable<AuthContext["org"]>; role: Role };

export const PART_SIZE = 8 * 1024 * 1024;
const MIN_PART = 5 * 1024 * 1024;

const isDoctor = (ctx: OrgCtx) => ctx.role === "doctor";

function canEdit(ctx: OrgCtx): void {
  if (ctx.role !== "admin" && ctx.role !== "technician") throw forbidden("Only lab admins and technicians can do this.");
}

/** Load a case within the tenant; doctors only see cases assigned to them. */
async function loadCase(tx: Tx, ctx: OrgCtx, caseId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw notFound("Case not found");
  const [c] = await tx.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.orgId, ctx.org.id))).limit(1);
  if (!c || (isDoctor(ctx) && c.doctorUserId !== ctx.user.id)) throw notFound("Case not found");
  return c;
}

async function loadRevision(tx: Tx, ctx: OrgCtx, revisionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(revisionId)) throw notFound("Revision not found");
  const [r] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.orgId, ctx.org.id))).limit(1);
  if (!r) throw notFound("Revision not found");
  const c = await loadCase(tx, ctx, r.caseId);
  return { r, c };
}

// ───────────────────────── cases ─────────────────────────

export interface CaseListFilter {
  q?: string;
  status?: string;
  software?: string;
}

export async function listCases(ctx: OrgCtx, f: CaseListFilter = {}) {
  return withTenant(ctx.org.id, (tx) => {
    const conds = [eq(cases.orgId, ctx.org.id)];
    if (isDoctor(ctx)) conds.push(eq(cases.doctorUserId, ctx.user.id));
    if (f.status) conds.push(eq(cases.status, f.status as never));
    if (f.software) conds.push(eq(cases.sourceSoftware, f.software));
    if (f.q?.trim()) {
      const q = `%${f.q.trim().replace(/[%_]/g, "")}%`;
      conds.push(or(ilike(patients.reference, q), sql`${cases.caseNumber}::text like ${q}`)!);
    }
    return tx
      .select({
        id: cases.id, caseNumber: cases.caseNumber, status: cases.status, sourceSoftware: cases.sourceSoftware,
        patientRef: patients.reference, doctorName: users.name, updatedAt: cases.lastActivityAt, createdAt: cases.createdAt,
        packagePrefix: revisions.packagePrefix, revisionNumber: revisions.number,
      })
      .from(cases)
      .innerJoin(patients, eq(patients.id, cases.patientId))
      .leftJoin(users, eq(users.id, cases.doctorUserId))
      .leftJoin(revisions, eq(revisions.id, cases.currentRevisionId))
      .where(and(...conds))
      .orderBy(desc(cases.lastActivityAt))
      .limit(500);
  });
}

/** Case counts per state (for dashboard tiles and tabs). */
export async function caseStats(ctx: OrgCtx): Promise<Record<string, number>> {
  const rows = await withTenant(ctx.org.id, (tx) =>
    tx
      .select({ status: cases.status, n: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(eq(cases.orgId, ctx.org.id), ...(isDoctor(ctx) ? [eq(cases.doctorUserId, ctx.user.id)] : [])))
      .groupBy(cases.status),
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/** Short-lived signed URL of a package thumbnail (null when the revision has no package). */
export async function thumbnailUrl(orgId: string, packagePrefix: string | null, name = "final-front.png"): Promise<string | null> {
  if (!packagePrefix) return null;
  assertTenantKey(orgId, packagePrefix);
  return storage().signedGetUrl(`${packagePrefix}/thumbnails/${name}`, 900);
}

export async function sourceSoftwareOptions(ctx: OrgCtx): Promise<string[]> {
  const rows = await withTenant(ctx.org.id, (tx) => tx.selectDistinct({ s: cases.sourceSoftware }).from(cases).where(eq(cases.orgId, ctx.org.id)));
  return rows.map((r) => r.s).filter((s): s is string => !!s).sort();
}

export interface CreateCaseInput {
  patientReference: string;
  patientDisplayName?: string;
  doctorUserId?: string | null;
  clinicId?: string | null;
}

export async function createCase(ctx: OrgCtx, input: CreateCaseInput) {
  canEdit(ctx);
  const ref = input.patientReference.trim();
  if (!ref || ref.length > 64) throw badRequest("Enter a patient reference (max 64 characters) — an identifier, not the full name.");
  const c = await withTenant(ctx.org.id, async (tx) => {
    const [o] = await tx
      .update(organizations)
      .set({ nextCaseNumber: sql`${organizations.nextCaseNumber} + 1` })
      .where(eq(organizations.id, ctx.org.id))
      .returning({ n: organizations.nextCaseNumber });
    const [p] = await tx.insert(patients).values({ orgId: ctx.org.id, reference: ref, displayName: input.patientDisplayName?.trim().split(/\s+/)[0]?.slice(0, 40) || null }).returning();
    const [row] = await tx
      .insert(cases)
      .values({ orgId: ctx.org.id, caseNumber: o.n - 1, patientId: p.id, doctorUserId: input.doctorUserId || null, clinicId: input.clinicId || null, status: "uploaded", createdBy: ctx.user.id })
      .returning();
    return row;
  });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, impersonatorUserId: ctx.impersonatorUserId, action: "case.created", targetType: "case", targetId: c.id });
  return c;
}

export async function updateCase(ctx: OrgCtx, caseId: string, input: { doctorUserId?: string | null; clinicId?: string | null }) {
  canEdit(ctx);
  return withTenant(ctx.org.id, async (tx) => {
    await loadCase(tx, ctx, caseId);
    const [c] = await tx.update(cases).set({ ...("doctorUserId" in input ? { doctorUserId: input.doctorUserId || null } : {}), ...("clinicId" in input ? { clinicId: input.clinicId || null } : {}) }).where(eq(cases.id, caseId)).returning();
    return c;
  });
}

export async function getCaseDetail(ctx: OrgCtx, caseId: string) {
  const detail = await withTenant(ctx.org.id, async (tx) => {
    const c = await loadCase(tx, ctx, caseId);
    const [p] = await tx.select().from(patients).where(eq(patients.id, c.patientId));
    const revs = await tx.select().from(revisions).where(eq(revisions.caseId, c.id)).orderBy(desc(revisions.number));
    const revIds = revs.map((r) => r.id);
    const jobRows = revIds.length ? await tx.select().from(jobs).where(inArray(jobs.revisionId, revIds)).orderBy(desc(jobs.createdAt)) : [];
    const commentRows = await tx
      .select({ id: comments.id, body: comments.body, revisionId: comments.revisionId, createdAt: comments.createdAt, authorName: users.name, authorId: comments.authorUserId })
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorUserId))
      .where(eq(comments.caseId, c.id))
      .orderBy(asc(comments.createdAt));
    const approvalRows = await tx
      .select({ id: approvals.id, revisionId: approvals.revisionId, decision: approvals.decision, note: approvals.note, createdAt: approvals.createdAt, userName: users.name })
      .from(approvals)
      .leftJoin(users, eq(users.id, approvals.userId))
      .where(eq(approvals.caseId, c.id))
      .orderBy(desc(approvals.createdAt));
    const shares = await tx.select().from(shareLinks).where(eq(shareLinks.caseId, c.id)).orderBy(desc(shareLinks.createdAt));
    const doctor = c.doctorUserId ? (await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, c.doctorUserId)))[0] : null;
    return { case: c, patient: p, revisions: revs, jobs: jobRows, comments: commentRows, approvals: approvalRows, shares, doctor };
  });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, impersonatorUserId: ctx.impersonatorUserId, action: "case.viewed", targetType: "case", targetId: caseId });
  return detail;
}

/** Permanently delete a case: database rows (cascade) and every stored object. */
export async function deleteCase(ctx: OrgCtx, caseId: string) {
  if (ctx.role !== "admin") throw forbidden("Only admins can delete cases.");
  await withTenant(ctx.org.id, async (tx) => {
    await loadCase(tx, ctx, caseId);
    await tx.delete(cases).where(eq(cases.id, caseId));
  });
  await storage().deletePrefix(`orgs/${ctx.org.id}/cases/${caseId}/`);
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, impersonatorUserId: ctx.impersonatorUserId, action: "case.deleted", targetType: "case", targetId: caseId });
}

// ───────────────────────── uploads (chunked, resumable, pre-signed) ─────────────────────────

export interface StartUploadFile {
  path: string;
  size: number;
}

export async function startUpload(ctx: OrgCtx, caseId: string, files: StartUploadFile[]) {
  canEdit(ctx);
  const c0 = config();
  if (!files.length) throw badRequest("Select at least one file.");
  if (files.length > c0.MAX_UPLOAD_FILES) throw badRequest(`At most ${c0.MAX_UPLOAD_FILES} files per upload.`);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > c0.MAX_UPLOAD_BYTES) throw badRequest(`Upload exceeds ${(c0.MAX_UPLOAD_BYTES / 1024 ** 3).toFixed(1)} GB.`);
  for (const f of files) {
    if (!Number.isFinite(f.size) || f.size < 0) throw badRequest("Invalid file size.");
    if (!f.path || f.path.length > 512 || f.path.includes("\0")) throw badRequest("Invalid file name.");
    if (f.path.split(/[\\/]/).some((s) => s === "..")) throw badRequest("File paths may not contain '..'.");
  }
  await assertCanProcess(ctx.org.id);
  const { revision, upload } = await withTenant(ctx.org.id, async (tx) => {
    const c = await loadCase(tx, ctx, caseId);
    const busy = await tx.select().from(revisions).where(and(eq(revisions.caseId, c.id), inArray(revisions.status, ["uploading", "uploaded", "processing"]))).limit(1);
    if (busy.length && busy[0].status !== "uploading") throw conflict("A revision of this case is still processing.");
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${revisions.number}), 0)` }).from(revisions).where(eq(revisions.caseId, c.id));
    const [revision] = await tx.insert(revisions).values({ orgId: ctx.org.id, caseId: c.id, number: Number(n) + 1, status: "uploading", createdBy: ctx.user.id }).returning();
    const [upload] = await tx.insert(uploads).values({ orgId: ctx.org.id, caseId: c.id, revisionId: revision.id, totalBytes: total, createdBy: ctx.user.id }).returning();
    await tx.update(revisions).set({ uploadId: upload.id }).where(eq(revisions.id, revision.id));
    return { revision, upload };
  });
  const prefix = revisionPrefix(ctx.org.id, caseId, revision.id);
  const s = storage();
  const fileRows: UploadFile[] = [];
  for (const [i, f] of files.entries()) {
    const key = uploadObjectKey(prefix, i, f.path);
    const partSize = Math.max(MIN_PART, PART_SIZE, Math.ceil(f.size / 9000));
    fileRows.push({ path: f.path.replace(/\\/g, "/"), size: f.size, key, multipartId: await s.createMultipart(key), partSize, completedParts: [], complete: false });
  }
  await withTenant(ctx.org.id, (tx) => tx.update(uploads).set({ files: fileRows }).where(eq(uploads.id, upload.id)));
  return { uploadId: upload.id, revisionId: revision.id, revisionNumber: revision.number, files: fileRows.map(publicFile) };
}

function publicFile(f: UploadFile, index = 0) {
  return { path: f.path, size: f.size, partSize: f.partSize, partCount: Math.max(1, Math.ceil(f.size / f.partSize)), completedParts: f.completedParts.map((p) => p.partNumber), complete: f.complete, index };
}

async function loadUpload(tx: Tx, ctx: OrgCtx, uploadId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw notFound("Upload not found");
  const [u] = await tx.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.orgId, ctx.org.id))).limit(1);
  if (!u) throw notFound("Upload not found");
  await loadCase(tx, ctx, u.caseId);
  return u;
}

export async function getUpload(ctx: OrgCtx, uploadId: string) {
  const u = await withTenant(ctx.org.id, (tx) => loadUpload(tx, ctx, uploadId));
  return { uploadId: u.id, status: u.status, revisionId: u.revisionId, files: u.files.map((f, i) => publicFile(f, i)) };
}

export async function partUrls(ctx: OrgCtx, uploadId: string, fileIndex: number, partNumbers: number[]) {
  canEdit(ctx);
  const u = await withTenant(ctx.org.id, (tx) => loadUpload(tx, ctx, uploadId));
  if (u.status !== "pending") throw conflict("Upload is already finished.");
  const f = u.files[fileIndex];
  if (!f) throw badRequest("Unknown file");
  const count = Math.max(1, Math.ceil(f.size / f.partSize));
  if (partNumbers.length > 100 || partNumbers.some((p) => !Number.isInteger(p) || p < 1 || p > count)) throw badRequest("Invalid part numbers");
  assertTenantKey(ctx.org.id, f.key);
  const s = storage();
  return Promise.all(partNumbers.map(async (p) => ({ partNumber: p, url: await s.signedPartUrl(f.key, f.multipartId!, p) })));
}

/** Record a finished part (enables resume across page reloads). */
export async function recordPart(ctx: OrgCtx, uploadId: string, fileIndex: number, partNumber: number, etag: string) {
  canEdit(ctx);
  if (!/^"?[A-Za-z0-9\-]{1,128}"?$/.test(etag)) throw badRequest("Invalid ETag");
  await withTenant(ctx.org.id, async (tx) => {
    // row lock: parts complete concurrently
    await tx.execute(sql`select 1 from uploads where id = ${uploadId} for update`);
    const u = await loadUpload(tx, ctx, uploadId);
    const f = u.files[fileIndex];
    if (!f) throw badRequest("Unknown file");
    f.completedParts = [...f.completedParts.filter((p) => p.partNumber !== partNumber), { partNumber, etag: etag.startsWith('"') ? etag : `"${etag}"` }];
    await tx.update(uploads).set({ files: u.files }).where(eq(uploads.id, u.id));
  });
}

export async function completeUpload(ctx: OrgCtx, uploadId: string) {
  canEdit(ctx);
  const u = await withTenant(ctx.org.id, (tx) => loadUpload(tx, ctx, uploadId));
  if (u.status === "complete") return { revisionId: u.revisionId! };
  const s = storage();
  for (const f of u.files) {
    if (f.complete) continue;
    const count = Math.max(1, Math.ceil(f.size / f.partSize));
    if (f.completedParts.length < count) throw badRequest(`${f.path} is not fully uploaded (${f.completedParts.length}/${count} parts).`);
    await s.completeMultipart(f.key, f.multipartId!, f.completedParts);
    f.complete = true;
  }
  const revisionId = u.revisionId!;
  const jobId = await withTenant(ctx.org.id, async (tx) => {
    await tx.update(uploads).set({ files: u.files, status: "complete", completedAt: new Date() }).where(eq(uploads.id, u.id));
    await tx.update(revisions).set({ status: "processing" }).where(eq(revisions.id, revisionId));
    // older revisions that never got approved are superseded by the new upload
    await tx
      .update(revisions)
      .set({ status: "superseded" })
      .where(and(eq(revisions.caseId, u.caseId), ne(revisions.id, revisionId), notInArray(revisions.status, ["approved", "published", "superseded"])));
    await tx.update(cases).set({ status: "processing", currentRevisionId: revisionId, lastActivityAt: new Date() }).where(eq(cases.id, u.caseId));
    const [job] = await tx.insert(jobs).values({ orgId: ctx.org.id, revisionId, status: "queued", message: "Waiting for a processing worker" }).returning();
    return job.id;
  });
  await enqueueProcessing({ jobId, revisionId, orgId: ctx.org.id });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, impersonatorUserId: ctx.impersonatorUserId, action: "revision.uploaded", targetType: "revision", targetId: revisionId, metadata: { files: u.files.length, bytes: u.totalBytes } });
  return { revisionId, jobId };
}

export async function abortUpload(ctx: OrgCtx, uploadId: string) {
  canEdit(ctx);
  const u = await withTenant(ctx.org.id, (tx) => loadUpload(tx, ctx, uploadId));
  if (u.status !== "pending") return;
  for (const f of u.files) if (f.multipartId && !f.complete) await storage().abortMultipart(f.key, f.multipartId).catch(() => undefined);
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(uploads).set({ status: "aborted" }).where(eq(uploads.id, u.id));
    if (u.revisionId) await tx.delete(revisions).where(and(eq(revisions.id, u.revisionId), eq(revisions.status, "uploading")));
  });
}

// ───────────────────────── processing state ─────────────────────────

export async function jobStatus(ctx: OrgCtx, revisionId: string) {
  return withTenant(ctx.org.id, async (tx) => {
    const { r } = await loadRevision(tx, ctx, revisionId);
    const [j] = await tx.select().from(jobs).where(eq(jobs.revisionId, r.id)).orderBy(desc(jobs.createdAt)).limit(1);
    return { revisionStatus: r.status, job: j ?? null, failureReason: r.failureReason };
  });
}

export async function retryRevision(ctx: OrgCtx | null, revisionId: string, orgId = ctx?.org.id) {
  if (ctx) canEdit(ctx);
  const run = async (tx: Tx) => {
    const [r] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.orgId, orgId!))).limit(1);
    if (!r) throw notFound();
    if (!["failed", "needs_mapping", "processing"].includes(r.status)) throw conflict("Only failed or stuck revisions can be retried.");
    await tx.update(revisions).set({ status: "processing", failureReason: null }).where(eq(revisions.id, r.id));
    await tx.update(cases).set({ status: "processing", lastActivityAt: new Date() }).where(eq(cases.id, r.caseId));
    const [job] = await tx.insert(jobs).values({ orgId: orgId!, revisionId: r.id, status: "queued", message: "Queued for retry" }).returning();
    return job.id;
  };
  const jobId = ctx ? await withTenant(orgId!, run) : await withSystem(run);
  await enqueueProcessing({ jobId, revisionId, orgId: orgId! });
  return jobId;
}

export interface ConfirmMappingInput {
  entries: { path: string; node?: string; role: string; jaw?: "upper" | "lower"; stageLabel?: string; fdi?: number; partKind?: string }[];
  saveTemplate?: boolean;
  templateName?: string;
  software?: string;
}

const ROLES = new Set(["stage", "scan-upper", "scan-lower", "scan-bite", "attachment-template", "retainer", "base", "tooth", "transforms", "ignore"]);

export async function confirmMapping(ctx: OrgCtx, revisionId: string, input: ConfirmMappingInput) {
  canEdit(ctx);
  for (const e of input.entries) {
    if (!ROLES.has(e.role)) throw badRequest(`Unknown role ${e.role}`);
    if ((e.role === "stage" || e.role === "tooth") && (!e.jaw || e.stageLabel === undefined || e.stageLabel === "")) throw badRequest(`${e.path}: choose upper/lower and a stage.`);
    if (e.stageLabel !== undefined && !/^(\d{1,3}|initial|final)$/.test(e.stageLabel)) throw badRequest(`${e.path}: invalid stage "${e.stageLabel}".`);
  }
  if (!input.entries.some((e) => e.role === "stage" || e.role === "tooth")) throw badRequest("Assign at least one file to a stage.");
  const mapping = { entries: input.entries.map((e) => ({ ...e })) };
  await withTenant(ctx.org.id, async (tx) => {
    const { r } = await loadRevision(tx, ctx, revisionId);
    if (r.status !== "needs_mapping" && r.status !== "failed") throw conflict("This revision does not need mapping.");
    await tx.update(revisions).set({ confirmedMapping: { ...mapping, ...(input.software?.trim() ? { software: input.software.trim() } : {}) } }).where(eq(revisions.id, r.id));
    if (input.saveTemplate !== false) {
      const { templateFromMapping } = await import("@dentosim/pipeline");
      const name = input.templateName?.trim() || `${input.software?.trim() || "Export"} layout`;
      const t = templateFromMapping(mapping as never, { id: crypto.randomUUID(), name, ...(input.software ? { software: input.software } : {}) });
      await tx.insert(mappingTemplates).values({ id: t.id, orgId: ctx.org.id, name, software: input.software?.trim() || null, template: t, createdBy: ctx.user.id });
    }
  });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "revision.mapping_confirmed", targetType: "revision", targetId: revisionId });
  return retryRevision(ctx, revisionId);
}

export async function listTemplates(ctx: OrgCtx) {
  return withTenant(ctx.org.id, (tx) => tx.select().from(mappingTemplates).where(eq(mappingTemplates.orgId, ctx.org.id)).orderBy(desc(mappingTemplates.createdAt)));
}

export async function deleteTemplate(ctx: OrgCtx, id: string) {
  canEdit(ctx);
  await withTenant(ctx.org.id, (tx) => tx.delete(mappingTemplates).where(and(eq(mappingTemplates.id, id), eq(mappingTemplates.orgId, ctx.org.id))));
}

// ───────────────────────── workflow ─────────────────────────

export async function sendToDoctor(ctx: OrgCtx, revisionId: string) {
  canEdit(ctx);
  const { c, r } = await withTenant(ctx.org.id, async (tx) => {
    const { r, c } = await loadRevision(tx, ctx, revisionId);
    if (r.status !== "ready_for_review" && r.status !== "changes_requested") throw conflict("Only a processed revision can be sent for review.");
    if (!c.doctorUserId) throw badRequest("Assign a doctor to the case first.");
    await tx.update(revisions).set({ status: "doctor_review" }).where(eq(revisions.id, r.id));
    await tx.update(cases).set({ status: "doctor_review", lastActivityAt: new Date() }).where(eq(cases.id, c.id));
    return { c, r };
  });
  const [doc] = await db().select().from(users).where(eq(users.id, c.doctorUserId!)).limit(1);
  if (doc)
    await sendEmail({
      to: doc.email, template: "case_sent_to_doctor", orgId: ctx.org.id, branding: await orgBranding(ctx.org.id),
      vars: { caseNumber: String(c.caseNumber), revision: String(r.number), url: `${config().APP_URL}/doctor/cases/${c.id}` },
    });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "revision.sent_to_doctor", targetType: "revision", targetId: revisionId });
}

export async function publishRevision(ctx: OrgCtx, revisionId: string) {
  if (ctx.role === "doctor") throw forbidden("The lab publishes approved plans.");
  await withTenant(ctx.org.id, async (tx) => {
    const { r, c } = await loadRevision(tx, ctx, revisionId);
    if (r.status !== "approved") throw conflict("Only an approved revision can be published.");
    await tx.update(revisions).set({ status: "superseded" }).where(and(eq(revisions.caseId, c.id), eq(revisions.status, "published")));
    await tx.update(revisions).set({ status: "published", publishedAt: new Date() }).where(eq(revisions.id, r.id));
    await tx.update(cases).set({ status: "published", publishedRevisionId: r.id, lastActivityAt: new Date() }).where(eq(cases.id, c.id));
  });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "revision.published", targetType: "revision", targetId: revisionId });
}

/** Short-lived signed URLs for every file of a revision's immutable package. */
export async function packageUrls(orgId: string, revisionId: string, opts: { ctx?: OrgCtx } = {}) {
  const r = opts.ctx
    ? await withTenant(orgId, async (tx) => (await loadRevision(tx, opts.ctx!, revisionId)).r)
    : await withSystem(async (tx) => (await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.orgId, orgId))).limit(1))[0]);
  if (!r?.packagePrefix) throw notFound("This revision has no simulation package yet.");
  assertTenantKey(orgId, r.packagePrefix);
  const s = storage();
  const meta = JSON.parse(new TextDecoder().decode(await s.get(`${r.packagePrefix}/metadata.json`))) as { files: Record<string, unknown> };
  const ttl = config().SIGNED_URL_TTL;
  const files: Record<string, string> = { "metadata.json": await s.signedGetUrl(`${r.packagePrefix}/metadata.json`, ttl) };
  for (const rel of Object.keys(meta.files)) files[rel] = await s.signedGetUrl(`${r.packagePrefix}/${rel}`, ttl);
  if (opts.ctx) await audit({ orgId, actorType: "user", actorUserId: opts.ctx.user.id, impersonatorUserId: opts.ctx.impersonatorUserId, action: "package.downloaded", targetType: "revision", targetId: revisionId });
  return { revisionId, expiresInS: ttl, files };
}

export type { MappingProposalRow };
