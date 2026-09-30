/**
 * Organisations (tenants): branding, domains, tenant detection by hostname,
 * members, clinics, retention.
 */
import { resolveTxt } from "node:dns/promises";
import { and, asc, eq } from "drizzle-orm";
import { audit } from "./audit.js";
import type { AuthContext } from "./auth.js";
import { config } from "./config.js";
import { randomToken } from "./crypto.js";
import { db, withTenant } from "./db/client.js";
import { clinics, domains, memberships, organizations, users, type Branding } from "./db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  branding: Branding;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function orgBranding(orgId: string): Promise<Branding & { orgName: string }> {
  const [o] = await db().select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!o) throw notFound();
  return { ...o.branding, orgName: o.name };
}

/** Tenant for a request hostname: custom domain (verified) or <slug>.<APP_BASE_DOMAIN>. */
const hostCache = new Map<string, { t: Tenant | null; at: number }>();
export async function tenantForHost(hostHeader: string | null | undefined): Promise<Tenant | null> {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < 30_000) return hit.t;
  let t: Tenant | null = null;
  const [d] = await db()
    .select({ o: organizations, verifiedAt: domains.verifiedAt })
    .from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.orgId))
    .where(eq(domains.hostname, host))
    .limit(1);
  if (d?.verifiedAt) t = { id: d.o.id, name: d.o.name, slug: d.o.slug, branding: d.o.branding };
  hostCache.set(host, { t, at: Date.now() });
  return t;
}

export async function addSubdomain(orgId: string): Promise<string> {
  const [o] = await db().select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const hostname = `${o.slug}.${config().APP_BASE_DOMAIN}`;
  await db().insert(domains).values({ orgId, hostname, kind: "subdomain", verificationToken: randomToken(12), verifiedAt: new Date() }).onConflictDoNothing();
  return hostname;
}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function addCustomDomain(ctx: AuthContext, hostnameIn: string) {
  assertAdmin(ctx);
  const hostname = hostnameIn.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!HOST_RE.test(hostname)) throw badRequest("Enter a domain like app.yourcompany.com");
  if (hostname.endsWith(`.${config().APP_BASE_DOMAIN}`)) throw badRequest("Use your own domain; subdomains of the platform are assigned automatically.");
  const [exists] = await db().select().from(domains).where(eq(domains.hostname, hostname)).limit(1);
  if (exists) throw conflict("That domain is already registered.");
  const [d] = await db().insert(domains).values({ orgId: ctx.org!.id, hostname, kind: "custom", verificationToken: `dentosim-verify=${randomToken(16)}` }).returning();
  await audit({ orgId: ctx.org!.id, actorType: "user", actorUserId: ctx.user.id, action: "org.domain_added", metadata: { hostname } });
  return d;
}

/**
 * Verify ownership: TXT record at _dentosim.<hostname> containing the token.
 * Routing: the customer CNAMEs <hostname> to the platform ingress (see README).
 */
export async function verifyCustomDomain(ctx: AuthContext, domainId: string, resolver: (name: string) => Promise<string[][]> = resolveTxt) {
  assertAdmin(ctx);
  const [d] = await db().select().from(domains).where(and(eq(domains.id, domainId), eq(domains.orgId, ctx.org!.id))).limit(1);
  if (!d) throw notFound();
  let records: string[][] = [];
  try {
    records = await resolver(`_dentosim.${d.hostname}`);
  } catch {
    records = [];
  }
  if (!records.some((r) => r.join("") === d.verificationToken)) throw badRequest(`TXT record not found yet. Add a TXT record at _dentosim.${d.hostname} with value ${d.verificationToken}`);
  await db().update(domains).set({ verifiedAt: new Date() }).where(eq(domains.id, d.id));
  hostCache.delete(d.hostname);
  await audit({ orgId: ctx.org!.id, actorType: "user", actorUserId: ctx.user.id, action: "org.domain_verified", metadata: { hostname: d.hostname } });
}

export async function listDomains(orgId: string) {
  return db().select().from(domains).where(eq(domains.orgId, orgId)).orderBy(asc(domains.createdAt));
}

export async function removeDomain(ctx: AuthContext, domainId: string) {
  assertAdmin(ctx);
  const [d] = await db().delete(domains).where(and(eq(domains.id, domainId), eq(domains.orgId, ctx.org!.id), eq(domains.kind, "custom"))).returning();
  if (d) hostCache.delete(d.hostname);
}

function assertAdmin(ctx: AuthContext) {
  if (!ctx.org || ctx.role !== "admin") throw forbidden("Only organisation admins can change this.");
}

export async function updateBranding(ctx: AuthContext, input: Branding & { name?: string }) {
  assertAdmin(ctx);
  for (const k of ["primaryColor", "secondaryColor", "gumColor"] as const)
    if (input[k] !== undefined && input[k] !== "" && !HEX.test(input[k]!)) throw badRequest(`${k} must be a hex colour like #0f766e`);
  for (const k of ["logoUrl", "faviconUrl"] as const)
    if (input[k] && !/^(https:\/\/|\/api\/branding\/)/.test(input[k]!)) throw badRequest(`${k} must be an https URL`);
  const clean = (v?: string) => (v === undefined ? undefined : v.trim().slice(0, 200) || undefined);
  const [o] = await db().select().from(organizations).where(eq(organizations.id, ctx.org!.id)).limit(1);
  const branding: Branding = { ...o.branding };
  for (const k of ["logoUrl", "faviconUrl", "primaryColor", "secondaryColor", "fontFamily", "gumColor", "emailFromName", "patientHeadline"] as const)
    if (k in input) {
      const v = clean(input[k]);
      if (v === undefined) delete branding[k];
      else branding[k] = v;
    }
  await db().update(organizations).set({ branding, ...(input.name?.trim() ? { name: input.name.trim().slice(0, 120) } : {}) }).where(eq(organizations.id, ctx.org!.id));
  hostCache.clear();
  await audit({ orgId: ctx.org!.id, actorType: "user", actorUserId: ctx.user.id, action: "org.branding_updated" });
  return branding;
}

export async function getOrg(orgId: string) {
  const [o] = await db().select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!o) throw notFound();
  return o;
}

export async function listMembers(orgId: string) {
  return db()
    .select({ id: memberships.id, userId: users.id, name: users.name, email: users.email, role: memberships.role, createdAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(users.name));
}

export async function listDoctors(orgId: string) {
  return (await listMembers(orgId)).filter((m) => m.role === "doctor" || m.role === "admin");
}

export async function removeMember(ctx: AuthContext, membershipId: string) {
  assertAdmin(ctx);
  const [m] = await db().select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.org!.id))).limit(1);
  if (!m) throw notFound();
  if (m.userId === ctx.user.id) throw badRequest("You cannot remove yourself.");
  await db().delete(memberships).where(eq(memberships.id, m.id));
  await audit({ orgId: ctx.org!.id, actorType: "user", actorUserId: ctx.user.id, action: "org.member_removed", targetType: "user", targetId: m.userId });
}

export async function setRetention(ctx: AuthContext, days: number | null) {
  assertAdmin(ctx);
  if (days !== null && (!Number.isInteger(days) || days < 30 || days > 3650)) throw badRequest("Retention must be between 30 and 3650 days, or unlimited.");
  await db().update(organizations).set({ retentionDays: days }).where(eq(organizations.id, ctx.org!.id));
  await audit({ orgId: ctx.org!.id, actorType: "user", actorUserId: ctx.user.id, action: "org.retention_updated", metadata: { days } });
}

export async function listClinics(orgId: string) {
  return withTenant(orgId, (tx) => tx.select().from(clinics).orderBy(asc(clinics.name)));
}

export async function createClinic(ctx: AuthContext, name: string) {
  assertAdmin(ctx);
  if (!name.trim()) throw badRequest("Clinic name is required.");
  return withTenant(ctx.org!.id, async (tx) => (await tx.insert(clinics).values({ orgId: ctx.org!.id, name: name.trim() }).returning())[0]);
}

export async function userOrgs(userId: string) {
  return db()
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId));
}
