import { getAuth, signup } from "../src/auth.js";
import type { OrgCtx } from "../src/cases.js";
import { randomToken } from "../src/crypto.js";
import { db } from "../src/db/client.js";
import { memberships, organizations, users } from "../src/db/schema.js";
import { hashPassword } from "../src/crypto.js";
import { createSession } from "../src/auth.js";
import { eq } from "drizzle-orm";

export async function newOrg(name = "Lab " + randomToken(4)) {
  const email = `admin-${randomToken(6)}@example.com`.toLowerCase();
  const r = await signup({ orgName: name, name: "Ada Admin", email, password: "correct horse battery", ip: randomToken(4) });
  // tests run with an active subscription unless they test billing
  await db().update(organizations).set({ subscriptionStatus: "active" }).where(eq(organizations.id, r.orgId));
  const ctx = (await getAuth(r.token)) as OrgCtx;
  return { ...r, email, ctx };
}

export async function addMember(orgId: string, role: "admin" | "technician" | "doctor", name = role) {
  const [u] = await db().insert(users).values({ email: `${role}-${randomToken(6)}@example.com`.toLowerCase(), name: `Dr ${name}`, passwordHash: await hashPassword("password12345"), emailVerifiedAt: new Date() }).returning();
  await db().insert(memberships).values({ orgId, userId: u.id, role });
  const token = await createSession(u.id, orgId);
  return { user: u, ctx: (await getAuth(token)) as OrgCtx, token };
}
