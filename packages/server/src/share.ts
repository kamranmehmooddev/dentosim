/**
 * Patient share links: https://<tenant host>/setup/<token>
 *
 * The token is 256 bits of randomness (non-sequential, unguessable) and maps
 * internally to {tenant, case, revision}; ids never appear in the URL. Only its
 * SHA-256 is indexed; an encrypted copy lets staff copy the link again.
 * Controls: expiry (never / date), revoke, optional 4–8 digit PIN.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { audit } from "./audit.js";
import type { OrgCtx } from "./cases.js";
import { config } from "./config.js";
import { decrypt, encrypt, hmac, randomToken, safeEqual, sha256 } from "./crypto.js";
import { db, withSystem, withTenant } from "./db/client.js";
import { cases, domains, organizations, patients, revisions, shareLinks, users, type Branding } from "./db/schema.js";
import { sendEmail } from "./email.js";
import { AppError, badRequest, conflict, notFound } from "./errors.js";
import { orgBranding } from "./orgs.js";
import { RATE_LIMITS, rateLimit, resetRateLimit } from "./redis.js";

export interface CreateShareInput {
  revisionId: string;
  expiresAt?: Date | null;
  pin?: string | null;
  emailTo?: string | null;
}

/** Preferred public origin for a tenant: verified custom domain, else subdomain, else APP_URL. */
export async function publicOrigin(orgId: string): Promise<string> {
  const c = config();
  const ds = await db().select().from(domains).where(eq(domains.orgId, orgId));
  const custom = ds.find((d) => d.kind === "custom" && d.verifiedAt);
  if (custom) return `https://${custom.hostname}`;
  if (c.APP_BASE_DOMAIN !== "localhost") {
    const sub = ds.find((d) => d.kind === "subdomain");
    if (sub) return `https://${sub.hostname}`;
  }
  return c.APP_URL;
}

export async function createShareLink(ctx: OrgCtx, input: CreateShareInput) {
  if (input.pin && !/^\d{4,8}$/.test(input.pin)) throw badRequest("The PIN must be 4–8 digits.");
  if (input.expiresAt && input.expiresAt.getTime() < Date.now()) throw badRequest("Expiry must be in the future.");
  const token = randomToken(32);
  const row = await withTenant(ctx.org.id, async (tx) => {
    const [r] = await tx.select().from(revisions).where(and(eq(revisions.id, input.revisionId), eq(revisions.orgId, ctx.org.id))).limit(1);
    if (!r) throw notFound("Revision not found");
    const [c] = await tx.select().from(cases).where(eq(cases.id, r.caseId)).limit(1);
    if (ctx.role === "doctor" && c.doctorUserId !== ctx.user.id) throw notFound("Revision not found");
    if (r.status !== "approved" && r.status !== "published") throw conflict("Share links can be created once the plan is approved.");
    const [row] = await tx
      .insert(shareLinks)
      .values({
        orgId: ctx.org.id, caseId: c.id, revisionId: r.id, tokenHash: sha256(token), tokenEnc: encrypt(token),
        pinHash: input.pin ? await argonHash(input.pin) : null, expiresAt: input.expiresAt ?? null, createdBy: ctx.user.id,
      })
      .returning();
    return row;
  });
  const url = `${await publicOrigin(ctx.org.id)}/setup/${token}`;
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "share.created", targetType: "share_link", targetId: row.id, metadata: { pin: !!input.pin, expires: input.expiresAt?.toISOString() ?? null } });
  if (input.emailTo) {
    const doctor = await doctorNameFor(row.caseId);
    await sendEmail({
      to: input.emailTo, template: "case_shared", orgId: ctx.org.id, branding: await orgBranding(ctx.org.id),
      vars: { doctor: doctor ?? ctx.org.name, url, pinNote: input.pin ? "Your practice will give you the PIN to open it." : "" },
    });
  }
  return { ...row, url };
}

async function doctorNameFor(caseId: string): Promise<string | null> {
  const rows = await withSystem((tx) => tx.select({ name: users.name }).from(cases).innerJoin(users, eq(users.id, cases.doctorUserId)).where(eq(cases.id, caseId)).limit(1));
  return rows[0]?.name ?? null;
}

export async function listShareLinks(ctx: OrgCtx, caseId: string) {
  const rows = await withTenant(ctx.org.id, (tx) => tx.select().from(shareLinks).where(and(eq(shareLinks.caseId, caseId), eq(shareLinks.orgId, ctx.org.id))).orderBy(desc(shareLinks.createdAt)));
  const origin = await publicOrigin(ctx.org.id);
  return rows.map(({ tokenEnc, tokenHash: _h, pinHash, ...r }) => ({ ...r, hasPin: !!pinHash, url: `${origin}/setup/${decrypt(tokenEnc)}`, active: !r.revokedAt && (!r.expiresAt || r.expiresAt > new Date()) }));
}

export async function revokeShareLink(ctx: OrgCtx, id: string) {
  const [row] = await withTenant(ctx.org.id, (tx) => tx.update(shareLinks).set({ revokedAt: new Date() }).where(and(eq(shareLinks.id, id), eq(shareLinks.orgId, ctx.org.id))).returning());
  if (!row) throw notFound();
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "share.revoked", targetType: "share_link", targetId: id });
}

export interface ResolvedShare {
  linkId: string;
  orgId: string;
  caseId: string;
  revisionId: string;
  pinRequired: boolean;
  org: { name: string; branding: Branding };
  patientName: string | null;
  doctorName: string | null;
}

export class ShareUnavailable extends AppError {
  constructor(public readonly reason: "not_found" | "expired" | "revoked") {
    super(reason === "not_found" ? 404 : 410, `SHARE_${reason.toUpperCase()}`, reason === "not_found" ? "This link is not valid." : reason === "expired" ? "This link has expired. Please ask your practice for a new one." : "This link is no longer active. Please ask your practice for a new one.");
  }
}

/** Resolve a public token (no account). Throws ShareUnavailable for invalid/expired/revoked links. */
export async function resolveShare(token: string, ip = "unknown"): Promise<ResolvedShare> {
  await rateLimit(RATE_LIMITS.shareView, ip);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ShareUnavailable("not_found");
  return withSystem(async (tx) => {
    const [row] = await tx
      .select({ l: shareLinks, o: organizations, p: patients, doctorName: users.name })
      .from(shareLinks)
      .innerJoin(organizations, eq(organizations.id, shareLinks.orgId))
      .innerJoin(cases, eq(cases.id, shareLinks.caseId))
      .innerJoin(patients, eq(patients.id, cases.patientId))
      .leftJoin(users, eq(users.id, cases.doctorUserId))
      .where(eq(shareLinks.tokenHash, sha256(token)))
      .limit(1);
    if (!row) throw new ShareUnavailable("not_found");
    if (row.l.revokedAt) throw new ShareUnavailable("revoked");
    if (row.l.expiresAt && row.l.expiresAt.getTime() <= Date.now()) throw new ShareUnavailable("expired");
    return {
      linkId: row.l.id, orgId: row.l.orgId, caseId: row.l.caseId, revisionId: row.l.revisionId, pinRequired: !!row.l.pinHash,
      org: { name: row.o.name, branding: row.o.branding }, patientName: row.p.displayName, doctorName: row.doctorName,
    };
  });
}

/** Grant cookie value proving the PIN was entered for this link (HMAC, 12 h). */
export function pinGrant(linkId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + 12 * 3600;
  return `${exp}.${hmac(`${linkId}.${exp}`, "share-pin")}`;
}

export function checkPinGrant(linkId: string, grant: string | undefined): boolean {
  if (!grant) return false;
  const [exp, sig] = grant.split(".");
  return Number(exp) > Date.now() / 1000 && !!sig && safeEqual(sig, hmac(`${linkId}.${exp}`, "share-pin"));
}

export async function verifySharePin(token: string, pin: string, ip = "unknown"): Promise<string> {
  const s = await resolveShare(token, ip);
  await rateLimit(RATE_LIMITS.sharePin, `${ip}:${s.linkId}`);
  const [row] = await withSystem((tx) => tx.select({ pinHash: shareLinks.pinHash }).from(shareLinks).where(eq(shareLinks.id, s.linkId)));
  if (!row.pinHash) return pinGrant(s.linkId);
  if (!/^\d{4,8}$/.test(pin) || !(await argonVerify(row.pinHash, pin).catch(() => false))) {
    await audit({ orgId: s.orgId, actorType: "patient", action: "share.pin_failed", targetType: "share_link", targetId: s.linkId, ip });
    throw new AppError(401, "BAD_PIN", "That PIN is not correct.");
  }
  await resetRateLimit(RATE_LIMITS.sharePin, `${ip}:${s.linkId}`);
  return pinGrant(s.linkId);
}

/** Record a patient view: counters, audit log, and PUBLISHED → PATIENT_VIEWED. */
export async function recordShareView(s: ResolvedShare, ip = "unknown"): Promise<void> {
  await withSystem(async (tx) => {
    await tx.update(shareLinks).set({ viewCount: sql`${shareLinks.viewCount} + 1`, lastViewedAt: new Date() }).where(eq(shareLinks.id, s.linkId));
    await tx.update(cases).set({ status: "patient_viewed", lastActivityAt: new Date() }).where(and(eq(cases.id, s.caseId), eq(cases.status, "published")));
  });
  await audit({ orgId: s.orgId, actorType: "patient", action: "share.viewed", targetType: "share_link", targetId: s.linkId, ip });
}
