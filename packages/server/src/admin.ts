/**
 * Platform admin console: organisations + usage, failed / needs-mapping jobs
 * with detection scores (to prioritise new adapters), job retry, audit-logged
 * impersonation. Retention enforcement lives here too.
 */
import { and, count, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { audit } from "./audit.js";
import { createSession, type AuthContext } from "./auth.js";
import { retryRevision } from "./cases.js";
import { db, withSystem } from "./db/client.js";
import { cases, jobs, memberships, organizations, revisions, usageRecords } from "./db/schema.js";
import { forbidden, notFound } from "./errors.js";
import { storage } from "./storage.js";

function assertPlatformAdmin(ctx: AuthContext | null): asserts ctx is AuthContext {
  if (!ctx?.user.isPlatformAdmin || ctx.impersonatorUserId) throw forbidden("Platform administrators only.");
}

export async function adminOrgs(ctx: AuthContext | null) {
  assertPlatformAdmin(ctx);
  return withSystem(async (tx) => {
    const orgs = await tx.select().from(organizations).orderBy(desc(organizations.createdAt));
    const usage = await tx.select({ orgId: usageRecords.orgId, n: count() }).from(usageRecords).groupBy(usageRecords.orgId);
    const month = await tx
      .select({ orgId: usageRecords.orgId, n: count() })
      .from(usageRecords)
      .where(sql`${usageRecords.createdAt} >= date_trunc('month', now())`)
      .groupBy(usageRecords.orgId);
    const caseCounts = await tx.select({ orgId: cases.orgId, n: count() }).from(cases).groupBy(cases.orgId);
    const members = await tx.select({ orgId: memberships.orgId, n: count() }).from(memberships).groupBy(memberships.orgId);
    const by = (rows: { orgId: string; n: number }[]) => new Map(rows.map((r) => [r.orgId, Number(r.n)]));
    const u = by(usage), m = by(month), cc = by(caseCounts), mm = by(members);
    return orgs.map((o) => ({
      id: o.id, name: o.name, slug: o.slug, status: o.status, subscriptionStatus: o.subscriptionStatus, trialEndsAt: o.trialEndsAt, createdAt: o.createdAt,
      processedCases: u.get(o.id) ?? 0, processedThisMonth: m.get(o.id) ?? 0, cases: cc.get(o.id) ?? 0, members: mm.get(o.id) ?? 0,
    }));
  });
}

/** Failed and needs-mapping jobs, newest first, with every detector's score. */
export async function adminProblemJobs(ctx: AuthContext | null, limit = 200) {
  assertPlatformAdmin(ctx);
  return withSystem((tx) =>
    tx
      .select({
        jobId: jobs.id, status: jobs.status, errorCode: jobs.errorCode, error: jobs.error, detection: jobs.detection, attempts: jobs.attempts,
        createdAt: jobs.createdAt, finishedAt: jobs.finishedAt, revisionId: jobs.revisionId, orgId: jobs.orgId, orgName: organizations.name, caseNumber: cases.caseNumber,
      })
      .from(jobs)
      .innerJoin(revisions, eq(revisions.id, jobs.revisionId))
      .innerJoin(cases, eq(cases.id, revisions.caseId))
      .innerJoin(organizations, eq(organizations.id, jobs.orgId))
      .where(inArray(jobs.status, ["failed", "needs_mapping"]))
      .orderBy(desc(jobs.createdAt))
      .limit(limit),
  );
}

export async function adminRetryJob(ctx: AuthContext | null, revisionId: string) {
  assertPlatformAdmin(ctx);
  const [r] = await withSystem((tx) => tx.select().from(revisions).where(eq(revisions.id, revisionId)).limit(1));
  if (!r) throw notFound();
  const jobId = await retryRevision(null, revisionId, r.orgId);
  await audit({ orgId: r.orgId, actorType: "platform_admin", actorUserId: ctx.user.id, action: "admin.job_retried", targetType: "revision", targetId: revisionId });
  return jobId;
}

/**
 * Start an impersonation session (1 h) as the org's first admin. Audit-logged
 * on both the platform and the tenant side; the UI shows a banner; approvals
 * are blocked while impersonating.
 */
export async function impersonate(ctx: AuthContext | null, orgId: string, reason: string): Promise<string> {
  assertPlatformAdmin(ctx);
  if (!reason.trim()) throw forbidden("A reason is required to impersonate.");
  const [m] = await db()
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin")))
    .orderBy(memberships.createdAt)
    .limit(1);
  if (!m) throw notFound("Organisation has no admin to impersonate.");
  const token = await createSession(m.userId, orgId, { impersonatorUserId: ctx.user.id });
  await audit({ orgId, actorType: "platform_admin", actorUserId: m.userId, impersonatorUserId: ctx.user.id, action: "admin.impersonation_started", metadata: { reason: reason.slice(0, 200) } });
  return token;
}

/**
 * Retention: hard-delete cases whose last activity is older than the
 * organisation's retention period (database rows + every stored object).
 */
export async function enforceRetention(now = new Date()): Promise<number> {
  const expired = await withSystem((tx) =>
    tx
      .select({ id: cases.id, orgId: cases.orgId })
      .from(cases)
      .innerJoin(organizations, eq(organizations.id, cases.orgId))
      .where(and(isNotNull(organizations.retentionDays), lt(cases.lastActivityAt, sql`${now.toISOString()}::timestamptz - make_interval(days => ${organizations.retentionDays})`)))
      .limit(1000),
  );
  for (const c of expired) {
    await storage().deletePrefix(`orgs/${c.orgId}/cases/${c.id}/`);
    await withSystem((tx) => tx.delete(cases).where(eq(cases.id, c.id)));
    await audit({ orgId: c.orgId, actorType: "system", action: "case.retention_deleted", targetType: "case", targetId: c.id });
  }
  return expired.length;
}

/** Fully delete an organisation (GDPR erasure / offboarding). */
export async function hardDeleteOrganization(ctx: AuthContext | null, orgId: string): Promise<void> {
  assertPlatformAdmin(ctx);
  await storage().deletePrefix(`orgs/${orgId}/`);
  await withSystem((tx) => tx.delete(organizations).where(eq(organizations.id, orgId)));
  // users without any remaining membership are removed too
  await db().execute(sql`delete from users u where not exists (select 1 from memberships m where m.user_id = u.id) and not u.is_platform_admin`);
  await audit({ actorType: "platform_admin", actorUserId: ctx.user.id, action: "case.deleted", targetType: "organization", targetId: orgId });
}

