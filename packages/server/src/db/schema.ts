/**
 * Database schema (PostgreSQL, Drizzle ORM).
 *
 * Tenancy: every tenant-owned row carries `org_id`. Tenant data tables are
 * additionally protected by Postgres row-level security (see migrations/rls.sql):
 * the application role can only see rows whose org_id equals the transaction's
 * `app.org_id` setting. All tenant access goes through `withTenant()` /
 * the scoped repositories in src/tenancy.
 */
import { sql } from "drizzle-orm";
import {
  bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const orgId = () => uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" });

export const roleEnum = pgEnum("role", ["admin", "technician", "doctor"]);

export const caseStatusEnum = pgEnum("case_status", [
  "uploaded", "processing", "needs_mapping", "ready_for_review", "doctor_review", "changes_requested",
  "approved", "published", "patient_viewed", "failed",
]);

export const revisionStatusEnum = pgEnum("revision_status", [
  "uploading", "uploaded", "processing", "needs_mapping", "ready_for_review", "doctor_review",
  "changes_requested", "approved", "published", "superseded", "failed",
]);

export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "needs_mapping", "failed"]);

export interface Branding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  fontFamily?: string;
  gumColor?: string;
  emailFromName?: string;
  patientHeadline?: string;
}

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  branding: jsonb("branding").$type<Branding>().notNull().default({}),
  status: text("status").notNull().default("active"), // active | suspended
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  trialCaseLimit: integer("trial_case_limit").notNull().default(10),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status"), // trialing | active | past_due | canceled | null
  setupFeePaidAt: timestamp("setup_fee_paid_at", { withTimezone: true }),
  retentionDays: integer("retention_days"), // null = keep until deleted
  nextCaseNumber: integer("next_case_number").notNull().default(10001),
  createdAt: createdAt(),
});

export const domains = pgTable("domains", {
  id: id(),
  orgId: orgId(),
  hostname: text("hostname").notNull().unique(),
  kind: text("kind").notNull(), // subdomain | custom
  verificationToken: text("verification_token").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    clinicId: uuid("clinic_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user").on(t.orgId, t.userId)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token)
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  impersonatorUserId: uuid("impersonator_user_id"),
  mfaPending: boolean("mfa_pending").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const authTokens = pgTable("auth_tokens", {
  id: text("id").primaryKey(), // sha256(token)
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // verify_email | reset_password | invite
  orgId: uuid("org_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const invitations = pgTable("invitations", {
  id: text("id").primaryKey(), // sha256(token)
  orgId: orgId(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull(),
  invitedBy: uuid("invited_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ───────────────────────── tenant data (RLS) ─────────────────────────

export const clinics = pgTable("clinics", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const patients = pgTable("patients", {
  id: id(),
  orgId: orgId(),
  /** minimal identifier chosen by the lab (e.g. "JD-1042") — never full names/DOB */
  reference: text("reference").notNull(),
  /** optional first name for the patient page greeting */
  displayName: text("display_name"),
  createdAt: createdAt(),
});

export const cases = pgTable(
  "cases",
  {
    id: id(),
    orgId: orgId(),
    caseNumber: integer("case_number").notNull(),
    patientId: uuid("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id").references(() => clinics.id, { onDelete: "set null" }),
    doctorUserId: uuid("doctor_user_id").references(() => users.id, { onDelete: "set null" }),
    status: caseStatusEnum("status").notNull().default("uploaded"),
    sourceSoftware: text("source_software"),
    currentRevisionId: uuid("current_revision_id"),
    publishedRevisionId: uuid("published_revision_id"),
    createdBy: uuid("created_by"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cases_org_number").on(t.orgId, t.caseNumber), index("cases_org_status").on(t.orgId, t.status)],
);

export interface RevisionSummary {
  stagesPerJaw: Record<string, number>;
  stageCount: number;
  adapter: { name: string; version: string };
  vendor: string;
  detection: { adapter: string; version: string; confidence: number; reason?: string }[];
  warnings: { code: string; severity: string; message: string }[];
  registration: { performed: boolean; note: string; upper?: { trimmedMeanMm: number; medianMm: number }; lower?: { trimmedMeanMm: number; medianMm: number } };
  segmentation: Record<string, { teeth: number; attachments: number; unsegmented: boolean }>;
  compression: { sourceBytes: number; meshBytes: number; ratio: number; errorTrimmedMeanMm: number };
  normalization?: { sourceUnits: string; interArch: string };
  packageBytes: number;
  processingMs: number;
}

export interface MappingProposalRow {
  entries: { path: string; node?: string; role: string; jaw?: string; stageLabel?: string; fdi?: number; partKind?: string; confidence?: number; reason?: string; thumbnailKey?: string }[];
  reasons: string[];
}

export const revisions = pgTable(
  "revisions",
  {
    id: id(),
    orgId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    status: revisionStatusEnum("status").notNull().default("uploading"),
    uploadId: uuid("upload_id"),
    packagePrefix: text("package_prefix"),
    summary: jsonb("summary").$type<RevisionSummary>(),
    mappingProposal: jsonb("mapping_proposal").$type<MappingProposalRow>(),
    confirmedMapping: jsonb("confirmed_mapping"),
    failureReason: text("failure_reason"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("revisions_case_number").on(t.caseId, t.number)],
);

export interface UploadFile {
  path: string;
  size: number;
  key: string;
  multipartId?: string;
  partSize: number;
  completedParts: { partNumber: number; etag: string }[];
  complete: boolean;
}

export const uploads = pgTable("uploads", {
  id: id(),
  orgId: orgId(),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id"),
  status: text("status").notNull().default("pending"), // pending | complete | aborted
  files: jsonb("files").$type<UploadFile[]>().notNull().default([]),
  totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: orgId(),
    revisionId: uuid("revision_id").notNull().references(() => revisions.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    step: text("step"),
    message: text("message"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    error: text("error"),
    detection: jsonb("detection"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status").on(t.status)],
);

export const mappingTemplates = pgTable("mapping_templates", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  software: text("software"),
  template: jsonb("template").notNull(),
  timesUsed: integer("times_used").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

export const comments = pgTable("comments", {
  id: id(),
  orgId: orgId(),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").references(() => revisions.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  orgId: orgId(),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => revisions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  decision: text("decision").notNull(), // approved | changes_requested
  note: text("note"),
  createdAt: createdAt(),
});

export const shareLinks = pgTable("share_links", {
  id: id(),
  orgId: orgId(),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => revisions.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  /** token encrypted with the app secret so staff can copy the link again */
  tokenEnc: text("token_enc").notNull(),
  pinHash: text("pin_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: createdAt(),
});

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: orgId(),
    caseId: uuid("case_id").notNull(),
    kind: text("kind").notNull().default("case_processed"),
    billable: boolean("billable").notNull().default(true),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  // one billable unit per case, however many revisions it gets
  (t) => [uniqueIndex("usage_case_kind").on(t.caseId, t.kind)],
);

// ───────────────────────── platform ─────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: uuid("org_id"),
    actorType: text("actor_type").notNull(), // user | patient | system | platform_admin
    actorUserId: uuid("actor_user_id"),
    impersonatorUserId: uuid("impersonator_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_time").on(t.orgId, t.createdAt)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // provider event id
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const emailOutbox = pgTable("email_outbox", {
  id: id(),
  orgId: uuid("org_id"),
  to: text("to").notNull(),
  template: text("template").notNull(),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("queued"), // queued | sent | failed
  providerId: text("provider_id"),
  error: text("error"),
  createdAt: createdAt(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const TENANT_TABLES = [
  "clinics", "patients", "cases", "revisions", "uploads", "jobs", "mapping_templates", "comments", "approvals", "share_links", "usage_records",
] as const;
