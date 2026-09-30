/** Doctor review: comments and revision-specific approval / change requests. */
import { and, eq } from "drizzle-orm";
import { audit } from "./audit.js";
import type { OrgCtx } from "./cases.js";
import { config } from "./config.js";
import { db, withTenant } from "./db/client.js";
import { approvals, cases, comments, revisions, users } from "./db/schema.js";
import { sendEmail } from "./email.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { orgBranding } from "./orgs.js";

async function load(ctx: OrgCtx, revisionId: string) {
  return withTenant(ctx.org.id, async (tx) => {
    const [r] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.orgId, ctx.org.id))).limit(1);
    if (!r) throw notFound("Revision not found");
    const [c] = await tx.select().from(cases).where(eq(cases.id, r.caseId)).limit(1);
    if (!c || (ctx.role === "doctor" && c.doctorUserId !== ctx.user.id)) throw notFound("Revision not found");
    return { r, c };
  });
}

export async function addComment(ctx: OrgCtx, caseId: string, body: string, revisionId?: string | null) {
  const text = body.trim();
  if (!text) throw badRequest("Write a comment first.");
  if (text.length > 5000) throw badRequest("Comment is too long.");
  const row = await withTenant(ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.orgId, ctx.org.id))).limit(1);
    if (!c || (ctx.role === "doctor" && c.doctorUserId !== ctx.user.id)) throw notFound("Case not found");
    if (revisionId) {
      const [r] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.caseId, c.id))).limit(1);
      if (!r) throw notFound("Revision not found");
    }
    const [row] = await tx.insert(comments).values({ orgId: ctx.org.id, caseId, revisionId: revisionId ?? null, authorUserId: ctx.user.id, body: text }).returning();
    await tx.update(cases).set({ lastActivityAt: new Date() }).where(eq(cases.id, caseId));
    return row;
  });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "review.commented", targetType: "case", targetId: caseId });
  return row;
}

export type Decision = "approved" | "changes_requested";

/**
 * Record the doctor's decision on one specific revision (timestamp + approver
 * identity). Only the case's doctor (or an org admin) can decide, and only while
 * that revision is in doctor review.
 */
export async function decide(ctx: OrgCtx, revisionId: string, decision: Decision, note?: string) {
  if (ctx.role === "technician") throw forbidden("Only the doctor can approve or request changes.");
  if (ctx.impersonatorUserId) throw forbidden("Approvals cannot be given while impersonating.");
  const { r, c } = await load(ctx, revisionId);
  if (ctx.role === "doctor" && c.doctorUserId !== ctx.user.id) throw forbidden();
  if (r.status !== "doctor_review") throw conflict(`Revision ${r.number} is not awaiting review.`);
  if (decision === "changes_requested" && !note?.trim()) throw badRequest("Please describe the changes you need.");
  const now = new Date();
  await withTenant(ctx.org.id, async (tx) => {
    await tx.insert(approvals).values({ orgId: ctx.org.id, caseId: c.id, revisionId: r.id, userId: ctx.user.id, decision, note: note?.trim() || null, createdAt: now });
    await tx
      .update(revisions)
      .set(decision === "approved" ? { status: "approved", approvedAt: now, approvedBy: ctx.user.id } : { status: "changes_requested" })
      .where(eq(revisions.id, r.id));
    await tx.update(cases).set({ status: decision === "approved" ? "approved" : "changes_requested", lastActivityAt: now }).where(eq(cases.id, c.id));
    if (note?.trim()) await tx.insert(comments).values({ orgId: ctx.org.id, caseId: c.id, revisionId: r.id, authorUserId: ctx.user.id, body: note.trim() });
  });
  await audit({
    orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id,
    action: decision === "approved" ? "review.approved" : "review.changes_requested", targetType: "revision", targetId: r.id, metadata: { revision: r.number },
  });
  // notify the lab member who uploaded the revision
  if (r.createdBy) {
    const [u] = await db().select().from(users).where(eq(users.id, r.createdBy)).limit(1);
    if (u)
      await sendEmail({
        to: u.email, template: decision === "approved" ? "case_approved" : "case_changes_requested", orgId: ctx.org.id, branding: await orgBranding(ctx.org.id),
        vars: { caseNumber: String(c.caseNumber), revision: String(r.number), doctor: ctx.user.name, url: `${config().APP_URL}/cases/${c.id}` },
      });
  }
}
