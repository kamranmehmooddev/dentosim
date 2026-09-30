/**
 * Audit log: every view, download, share, approval, impersonation and deletion.
 * Metadata must never contain PHI (no patient names/references) — ids only.
 */
import { and, desc, eq } from "drizzle-orm";
import { sha256 } from "./crypto.js";
import { db, type Executor } from "./db/client.js";
import { auditLogs } from "./db/schema.js";

export type AuditAction =
  | "auth.login" | "auth.login_failed" | "auth.logout" | "auth.password_reset" | "auth.totp_enabled" | "auth.totp_disabled"
  | "org.created" | "org.branding_updated" | "org.member_invited" | "org.member_removed" | "org.domain_added" | "org.domain_verified" | "org.retention_updated"
  | "case.created" | "case.viewed" | "case.deleted" | "case.retention_deleted"
  | "revision.uploaded" | "revision.processed" | "revision.mapping_confirmed" | "revision.published" | "revision.sent_to_doctor"
  | "package.downloaded"
  | "review.approved" | "review.changes_requested" | "review.commented"
  | "share.created" | "share.revoked" | "share.viewed" | "share.pin_failed"
  | "admin.impersonation_started" | "admin.impersonation_ended" | "admin.job_retried"
  | "billing.checkout_started" | "billing.subscription_updated";

export interface AuditEntry {
  orgId?: string | null;
  actorType: "user" | "patient" | "system" | "platform_admin";
  actorUserId?: string | null;
  impersonatorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(e: AuditEntry, exec: Executor = db()): Promise<void> {
  await exec.insert(auditLogs).values({
    orgId: e.orgId ?? null,
    actorType: e.actorType,
    actorUserId: e.actorUserId ?? null,
    impersonatorUserId: e.impersonatorUserId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    metadata: e.metadata ?? {},
    // IPs are personal data: store a salted hash only (enough to correlate abuse)
    ipHash: e.ip ? sha256(`ip:${e.ip}`).slice(0, 32) : null,
  });
}

export async function listAudit(orgId: string, opts: { limit?: number; targetId?: string } = {}) {
  return db()
    .select()
    .from(auditLogs)
    .where(opts.targetId ? and(eq(auditLogs.orgId, orgId), eq(auditLogs.targetId, opts.targetId)) : eq(auditLogs.orgId, orgId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(opts.limit ?? 200);
}
