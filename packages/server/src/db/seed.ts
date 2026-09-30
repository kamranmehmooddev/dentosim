/**
 * Development seed: a platform admin and a demo lab ("Demo Aligners") with an
 * admin, a technician and a doctor. Idempotent.
 *
 *   SEED_PASSWORD=... pnpm --filter @dentosim/server db:seed
 */
import { eq } from "drizzle-orm";
import { addSubdomain } from "../orgs.js";
import { hashPassword } from "../crypto.js";
import { closeDb, db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { memberships, organizations, users } from "./schema.js";

async function user(email: string, name: string, password: string, isPlatformAdmin = false) {
  const [u] = await db().select().from(users).where(eq(users.email, email)).limit(1);
  if (u) return u;
  return (await db().insert(users).values({ email, name, passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), isPlatformAdmin }).returning())[0];
}

async function main() {
  await runMigrations();
  const pw = process.env.SEED_PASSWORD ?? "dentosim-demo-2026";
  await user("platform@dentosim.local", "Platform Admin", pw, true);
  let [org] = await db().select().from(organizations).where(eq(organizations.slug, "demo")).limit(1);
  if (!org)
    [org] = await db()
      .insert(organizations)
      .values({ name: "Demo Aligners", slug: "demo", subscriptionStatus: "active", branding: { primaryColor: "#0f766e", patientHeadline: "Your Treatment Simulation" } })
      .returning();
  await addSubdomain(org.id);
  for (const [email, name, role] of [
    ["admin@demo.local", "Alex Admin", "admin"],
    ["tech@demo.local", "Taylor Technician", "technician"],
    ["doctor@demo.local", "Dr. Dana Smith", "doctor"],
  ] as const) {
    const u = await user(email, name, pw);
    await db().insert(memberships).values({ orgId: org.id, userId: u.id, role }).onConflictDoNothing();
  }
  console.log(`seeded: platform@dentosim.local, admin@demo.local, tech@demo.local, doctor@demo.local (password: ${pw})`);
}

main().then(closeDb).catch((e) => {
  console.error(e);
  process.exit(1);
});
