import Link from "next/link";
import { requirePageAuth } from "@/lib/session";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageAuth();
  const items = ctx.role === "doctor"
    ? [["/settings/security", "Security"]]
    : [
        ["/settings", "Organisation & branding"], ["/settings/members", "Members"], ["/settings/domains", "Domains"],
        ["/settings/billing", "Billing"], ["/settings/templates", "Import templates"], ["/settings/data", "Data & retention"], ["/settings/security", "Security"],
      ];
  return (
    <div className="grid gap-6 md:grid-cols-[220px_1fr]">
      <nav className="flex gap-1 overflow-x-auto md:flex-col">
        {items.map(([href, label]) => (
          <Link key={href} href={href} className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-stone-100">{label}</Link>
        ))}
      </nav>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}
