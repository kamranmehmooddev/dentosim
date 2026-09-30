/**
 * Authentication: email + password (argon2id), sessions (opaque token in an
 * HttpOnly cookie, only its SHA-256 stored), email verification, password reset,
 * optional TOTP second factor, invitations.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { decrypt, encrypt, hashPassword, newTotpSecret, randomToken, sha256, totpUri, verifyPassword, verifyTotp } from "./crypto.js";
import { db } from "./db/client.js";
import { authTokens, invitations, memberships, organizations, sessions, users } from "./db/schema.js";
import { sendEmail } from "./email.js";
import { AppError, badRequest, conflict, forbidden, unauthorized } from "./errors.js";
import { RATE_LIMITS, rateLimit, resetRateLimit } from "./redis.js";

export type Role = "admin" | "technician" | "doctor";

export const SESSION_COOKIE = "ds_session";
const SESSION_DAYS = 14;
const IMPERSONATION_MINUTES = 60;

export interface AuthContext {
  sessionId: string;
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; emailVerified: boolean; totpEnabled: boolean };
  org: { id: string; name: string; slug: string } | null;
  role: Role | null;
  impersonatorUserId: string | null;
}

export function validatePassword(pw: string): void {
  if (pw.length < 10) throw badRequest("Password must be at least 10 characters.");
  if (pw.length > 256) throw badRequest("Password is too long.");
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function createSession(userId: string, orgId: string | null, opts: { impersonatorUserId?: string; mfaPending?: boolean } = {}): Promise<string> {
  const token = randomToken();
  const minutes = opts.impersonatorUserId ? IMPERSONATION_MINUTES : SESSION_DAYS * 24 * 60;
  await db().insert(sessions).values({
    id: sha256(token),
    userId,
    orgId,
    impersonatorUserId: opts.impersonatorUserId ?? null,
    mfaPending: !!opts.mfaPending,
    expiresAt: new Date(Date.now() + minutes * 60_000),
  });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** Resolve a session token into an auth context (null if missing/expired/MFA pending). */
export async function getAuth(token: string | undefined | null, opts: { allowMfaPending?: boolean } = {}): Promise<AuthContext | null> {
  if (!token) return null;
  const [row] = await db()
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  if (row.s.mfaPending && !opts.allowMfaPending) return null;
  let org: AuthContext["org"] = null, role: Role | null = null;
  if (row.s.orgId) {
    const [m] = await db()
      .select({ role: memberships.role, org: organizations })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, row.u.id), eq(memberships.orgId, row.s.orgId)))
      .limit(1);
    if (m) {
      org = { id: m.org.id, name: m.org.name, slug: m.org.slug };
      role = m.role;
    } else if (row.s.impersonatorUserId || row.u.isPlatformAdmin) {
      const [o] = await db().select().from(organizations).where(eq(organizations.id, row.s.orgId)).limit(1);
      if (o) { org = { id: o.id, name: o.name, slug: o.slug }; role = "admin"; }
    }
  }
  return {
    sessionId: row.s.id,
    user: { id: row.u.id, email: row.u.email, name: row.u.name, isPlatformAdmin: row.u.isPlatformAdmin, emailVerified: !!row.u.emailVerifiedAt, totpEnabled: !!row.u.totpEnabledAt },
    org,
    role,
    impersonatorUserId: row.s.impersonatorUserId,
  };
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lab";
}

async function issueToken(userId: string, kind: "verify_email" | "reset_password", hours: number): Promise<string> {
  const token = randomToken();
  await db().insert(authTokens).values({ id: sha256(token), userId, kind, expiresAt: new Date(Date.now() + hours * 3600_000) });
  return token;
}

async function consumeToken(token: string, kind: string): Promise<string> {
  const [t] = await db()
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, sha256(token)), eq(authTokens.kind, kind), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .returning();
  if (!t) throw badRequest("This link is invalid or has expired.");
  return t.userId;
}

export interface SignupInput {
  orgName: string;
  name: string;
  email: string;
  password: string;
  ip?: string;
}

/** Self-service signup: creates the lab organisation (on trial), its admin and a session. */
export async function signup(input: SignupInput): Promise<{ token: string; userId: string; orgId: string }> {
  await rateLimit(RATE_LIMITS.signup, input.ip ?? "unknown");
  validatePassword(input.password);
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("Please enter a valid email address.");
  if (!input.orgName.trim() || !input.name.trim()) throw badRequest("Organisation and name are required.");
  const [existing] = await db().select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw conflict("An account with this email already exists. Sign in instead.");
  const c = config();
  const passwordHash = await hashPassword(input.password);
  const { userId, orgId } = await db().transaction(async (tx) => {
    let slug = slugify(input.orgName);
    for (let i = 2; (await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1)).length; i++)
      slug = `${slugify(input.orgName)}-${i}`;
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.orgName.trim(), slug, trialEndsAt: new Date(Date.now() + c.TRIAL_DAYS * 86400_000), trialCaseLimit: c.TRIAL_CASE_LIMIT, subscriptionStatus: "trialing" })
      .returning();
    const [user] = await tx.insert(users).values({ email, name: input.name.trim(), passwordHash }).returning();
    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: "admin" });
    return { userId: user.id, orgId: org.id };
  });
  // subdomain <slug>.<base> is reserved for the tenant
  const { addSubdomain } = await import("./orgs.js");
  await addSubdomain(orgId);
  await audit({ orgId, actorType: "user", actorUserId: userId, action: "org.created", targetType: "organization", targetId: orgId, ip: input.ip });
  await sendVerification(userId);
  return { token: await createSession(userId, orgId), userId, orgId };
}

export async function sendVerification(userId: string): Promise<void> {
  const [u] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.emailVerifiedAt) return;
  const token = await issueToken(userId, "verify_email", 48);
  await sendEmail({ to: u.email, template: "verify_email", vars: { url: `${config().APP_URL}/verify-email?token=${token}` } });
}

export async function verifyEmail(token: string): Promise<void> {
  const userId = await consumeToken(token, "verify_email");
  await db().update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

let dummy: Promise<string> | undefined;
/** a real hash to verify against when the email is unknown (uniform timing) */
const dummyHash = () => (dummy ??= hashPassword(randomToken()));

export interface LoginResult {
  token: string;
  mfaRequired: boolean;
}

export async function login(emailIn: string, password: string, ip = "unknown"): Promise<LoginResult> {
  const email = normalizeEmail(emailIn);
  await rateLimit(RATE_LIMITS.login, `${ip}:${email}`);
  const [u] = await db().select().from(users).where(eq(users.email, email)).limit(1);
  // always run a hash verification to keep timing uniform
  const ok = u ? await verifyPassword(u.passwordHash, password) : (await verifyPassword(await dummyHash(), password), false);
  if (!u || !ok) {
    await audit({ actorType: "user", actorUserId: u?.id, action: "auth.login_failed", ip });
    throw unauthorized("Email or password is incorrect.");
  }
  await resetRateLimit(RATE_LIMITS.login, `${ip}:${email}`);
  const [m] = await db().select().from(memberships).where(eq(memberships.userId, u.id)).limit(1);
  const mfa = !!u.totpEnabledAt;
  const token = await createSession(u.id, m?.orgId ?? null, { mfaPending: mfa });
  if (!mfa) await audit({ orgId: m?.orgId, actorType: "user", actorUserId: u.id, action: "auth.login", ip });
  return { token, mfaRequired: mfa };
}

export async function completeMfa(token: string, code: string, ip = "unknown"): Promise<void> {
  const ctx = await getAuth(token, { allowMfaPending: true });
  if (!ctx) throw unauthorized();
  await rateLimit(RATE_LIMITS.totp, ctx.user.id);
  const [u] = await db().select().from(users).where(eq(users.id, ctx.user.id)).limit(1);
  if (!u.totpSecretEnc || !u.totpEnabledAt || !verifyTotp(decrypt(u.totpSecretEnc), code)) throw unauthorized("That code is not valid.");
  await db().update(sessions).set({ mfaPending: false }).where(eq(sessions.id, sha256(token)));
  await audit({ orgId: ctx.org?.id, actorType: "user", actorUserId: u.id, action: "auth.login", metadata: { mfa: true }, ip });
}

export async function requestPasswordReset(emailIn: string, ip = "unknown"): Promise<void> {
  await rateLimit(RATE_LIMITS.passwordReset, ip);
  const [u] = await db().select().from(users).where(eq(users.email, normalizeEmail(emailIn))).limit(1);
  if (!u) return; // do not reveal whether the account exists
  const token = await issueToken(u.id, "reset_password", 1);
  await sendEmail({ to: u.email, template: "reset_password", vars: { url: `${config().APP_URL}/reset-password?token=${token}` } });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  validatePassword(newPassword);
  const userId = await consumeToken(token, "reset_password");
  await db().update(users).set({ passwordHash: await hashPassword(newPassword), emailVerifiedAt: new Date() }).where(eq(users.id, userId));
  await db().delete(sessions).where(eq(sessions.userId, userId)); // sign out everywhere
  await audit({ actorType: "user", actorUserId: userId, action: "auth.password_reset" });
}

// ───────────── TOTP ─────────────

export async function beginTotpSetup(userId: string): Promise<{ secret: string; uri: string }> {
  const [u] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (u.totpEnabledAt) throw conflict("Two-factor authentication is already enabled.");
  const secret = newTotpSecret();
  await db().update(users).set({ totpSecretEnc: encrypt(secret) }).where(eq(users.id, userId));
  return { secret, uri: totpUri(secret, u.email) };
}

export async function confirmTotpSetup(userId: string, code: string): Promise<void> {
  const [u] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u.totpSecretEnc || !verifyTotp(decrypt(u.totpSecretEnc), code)) throw badRequest("That code is not valid.");
  await db().update(users).set({ totpEnabledAt: new Date() }).where(eq(users.id, userId));
  await audit({ actorType: "user", actorUserId: userId, action: "auth.totp_enabled" });
}

export async function disableTotp(userId: string, password: string, code: string): Promise<void> {
  const [u] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!(await verifyPassword(u.passwordHash, password))) throw unauthorized("Password is incorrect.");
  if (!u.totpSecretEnc || !verifyTotp(decrypt(u.totpSecretEnc), code)) throw badRequest("That code is not valid.");
  await db().update(users).set({ totpEnabledAt: null, totpSecretEnc: null }).where(eq(users.id, userId));
  await audit({ actorType: "user", actorUserId: userId, action: "auth.totp_disabled" });
}

// ───────────── invitations ─────────────

export async function inviteMember(ctx: AuthContext, emailIn: string, role: Role): Promise<string> {
  if (ctx.role !== "admin" || !ctx.org) throw forbidden("Only admins can invite members.");
  const email = normalizeEmail(emailIn);
  const token = randomToken();
  await db().insert(invitations).values({ id: sha256(token), orgId: ctx.org.id, email, role, invitedBy: ctx.user.id, expiresAt: new Date(Date.now() + 7 * 86400_000) });
  const { orgBranding } = await import("./orgs.js");
  const b = await orgBranding(ctx.org.id);
  await sendEmail({
    to: email, template: "invite", orgId: ctx.org.id, branding: b,
    vars: { orgName: ctx.org.name, inviter: ctx.user.name, role, url: `${config().APP_URL}/invite?token=${token}` },
  });
  await audit({ orgId: ctx.org.id, actorType: "user", actorUserId: ctx.user.id, action: "org.member_invited", metadata: { role } });
  return token;
}

export async function getInvitation(token: string) {
  const [inv] = await db()
    .select({ inv: invitations, orgName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(and(eq(invitations.id, sha256(token)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
    .limit(1);
  return inv ?? null;
}

/** Accept an invitation, creating the user when needed. Returns a new session token. */
export async function acceptInvitation(token: string, input: { name?: string; password: string }): Promise<string> {
  const found = await getInvitation(token);
  if (!found) throw badRequest("This invitation is invalid or has expired.");
  const { inv } = found;
  let [u] = await db().select().from(users).where(eq(users.email, inv.email)).limit(1);
  if (u) {
    if (!(await verifyPassword(u.passwordHash, input.password))) throw unauthorized("An account with this email exists; enter its password to join.");
  } else {
    validatePassword(input.password);
    if (!input.name?.trim()) throw badRequest("Please enter your name.");
    [u] = await db().insert(users).values({ email: inv.email, name: input.name.trim(), passwordHash: await hashPassword(input.password), emailVerifiedAt: new Date() }).returning();
  }
  await db().insert(memberships).values({ orgId: inv.orgId, userId: u.id, role: inv.role }).onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: inv.role } });
  await db().update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
  return createSession(u.id, inv.orgId);
}

export async function switchOrg(ctx: AuthContext, orgId: string): Promise<void> {
  const [m] = await db().select().from(memberships).where(and(eq(memberships.userId, ctx.user.id), eq(memberships.orgId, orgId))).limit(1);
  if (!m && !ctx.user.isPlatformAdmin) throw forbidden();
  await db().update(sessions).set({ orgId }).where(eq(sessions.id, ctx.sessionId));
}

export function requireOrg(ctx: AuthContext | null): asserts ctx is AuthContext & { org: NonNullable<AuthContext["org"]>; role: Role } {
  if (!ctx) throw unauthorized();
  if (!ctx.org || !ctx.role) throw new AppError(403, "NO_ORG", "You are not a member of an organisation.");
}

export function requireRole(ctx: AuthContext, ...roles: Role[]): void {
  if (!ctx.role || !roles.includes(ctx.role)) throw forbidden();
}
