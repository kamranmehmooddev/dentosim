import { count, and, eq, inArray } from "drizzle-orm";
import { cases, getOrg, userOrgs, withTenant } from "@dentosim/server";
import { brandStyle } from "@/lib/branding";
import { requirePageAuth } from "@/lib/session";
import { ResendVerification, StopImpersonation } from "@/components/app/shell";
import { Sidebar } from "@/components/app/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageAuth();
  const [org, orgs] = await Promise.all([getOrg(ctx.org.id), userOrgs(ctx.user.id)]);
  const counts = await withTenant(ctx.org.id, async (tx) => {
    const mine = ctx.role === "doctor" ? [eq(cases.doctorUserId, ctx.user.id)] : [];
    const [review] = await tx.select({ n: count() }).from(cases).where(and(eq(cases.orgId, ctx.org.id), eq(cases.status, "doctor_review"), ...mine));
    const [attention] = await tx.select({ n: count() }).from(cases).where(and(eq(cases.orgId, ctx.org.id), inArray(cases.status, ["needs_mapping", "failed", "ready_for_review", "changes_requested", "approved"])));
    return { review: Number(review.n), attention: Number(attention.n) };
  });
  return (
    <div style={brandStyle(org.branding)} className="min-h-dvh">
      <Sidebar
        role={ctx.role}
        user={{ name: ctx.user.name, email: ctx.user.email }}
        org={{ id: org.id, name: org.name, logoUrl: org.branding.logoUrl }}
        orgs={orgs.map((o) => ({ id: o.id, name: o.name }))}
        platformAdmin={ctx.user.isPlatformAdmin && !ctx.impersonatorUserId}
        counts={counts}
      />
      <div className="lg:pl-[248px]">
        {ctx.impersonatorUserId && (
          <div className="flex items-center justify-center gap-3 bg-gradient-to-r from-amber-400 to-orange-400 px-4 py-2 text-[13px] font-medium text-amber-950">
            Support session — acting as {ctx.user.name} in {org.name}. Every action is audit-logged.
            <StopImpersonation />
          </div>
        )}
        {!ctx.user.emailVerified && !ctx.impersonatorUserId && (
          <div className="border-b border-sky-100 bg-sky-50/80 px-4 py-2 text-center text-[13px] text-sky-900">
            Confirm your email address to secure your account. <ResendVerification />
          </div>
        )}
        <main className="mx-auto max-w-[1320px] px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
