import Link from "next/link";
import { getOrg, userOrgs } from "@dentosim/server";
import { brandStyle } from "@/lib/branding";
import { requirePageAuth } from "@/lib/session";
import { OrgSwitcher, SignOutButton, StopImpersonation, ResendVerification } from "@/components/app/shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageAuth();
  const org = await getOrg(ctx.org.id);
  const orgs = await userOrgs(ctx.user.id);
  const nav =
    ctx.role === "doctor"
      ? [{ href: "/doctor", label: "My cases" }, { href: "/settings/security", label: "Security" }]
      : [
          { href: "/dashboard", label: "Cases" },
          { href: "/cases/new", label: "New case" },
          { href: "/settings", label: "Settings" },
          ...(ctx.user.isPlatformAdmin && !ctx.impersonatorUserId ? [{ href: "/admin", label: "Admin" }] : []),
        ];
  return (
    <div style={brandStyle(org.branding)} className="min-h-dvh">
      {ctx.impersonatorUserId && (
        <div className="flex items-center justify-center gap-3 bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950">
          Support session: you are acting as {ctx.user.name} in {org.name}. All actions are audit-logged.
          <StopImpersonation />
        </div>
      )}
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2">
            {org.branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.branding.logoUrl} alt={org.name} className="h-7 max-w-[140px] object-contain" />
            ) : (
              <span className="font-semibold tracking-tight text-brand">{org.name}</span>
            )}
          </Link>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 hover:text-stone-900">{n.label}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {orgs.length > 1 && <OrgSwitcher orgs={orgs} current={ctx.org.id} />}
            <span className="hidden text-sm text-stone-600 sm:inline">{ctx.user.name}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      {!ctx.user.emailVerified && !ctx.impersonatorUserId && (
        <div className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-center text-sm text-sky-900">
          Please confirm your email address — check your inbox. <ResendVerification />
        </div>
      )}
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
