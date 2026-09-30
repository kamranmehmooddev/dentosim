"use client";

import {
  ChevronsUpDown, CreditCard, FolderPlus, Globe, LayoutGrid, LifeBuoy, LogOut, Menu, Palette, ShieldCheck, Stethoscope, Users, X, Boxes, Database, KeyRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Avatar, cx } from "@/components/ui";
import { api } from "@/lib/client";
import { BrandLogo } from "./Logo";

interface Props {
  role: "admin" | "technician" | "doctor";
  user: { name: string; email: string };
  org: { id: string; name: string; logoUrl?: string };
  orgs: { id: string; name: string }[];
  platformAdmin: boolean;
  counts: { review: number; attention: number };
}

type Item = { href: string; label: string; icon: ReactNode; badge?: number; exact?: boolean };

function NavLink({ item, onNavigate }: { item: Item; onNavigate?: () => void }) {
  const path = usePathname();
  const active = item.exact ? path === item.href : path === item.href || path.startsWith(item.href + "/");
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cx(
        "group relative flex h-9 items-center gap-3 rounded-[10px] px-3 text-[13.5px] font-medium transition",
        active ? "bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100",
      )}
    >
      {active && <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-2" />}
      <span className={cx("[&>svg]:h-[17px] [&>svg]:w-[17px]", active ? "text-brand-2" : "text-zinc-500 group-hover:text-zinc-300")}>{item.icon}</span>
      <span className="flex-1">{item.label}</span>
      {!!item.badge && <span className="rounded-full bg-white/10 px-1.5 text-[11px] font-semibold text-zinc-200 tabular">{item.badge}</span>}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="px-3 pb-1.5 pt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-600">{title}</div>
      {children}
    </div>
  );
}

function SidebarBody({ role, user, org, orgs, platformAdmin, counts, onNavigate }: Props & { onNavigate?: () => void }) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const work: Item[] =
    role === "doctor"
      ? [{ href: "/dashboard", label: "My cases", icon: <Stethoscope />, badge: counts.review }]
      : [
          { href: "/dashboard", label: "Cases", icon: <LayoutGrid />, badge: counts.attention },
          { href: "/cases/new", label: "New case", icon: <FolderPlus /> },
        ];
  const settings: Item[] =
    role === "doctor"
      ? [{ href: "/settings/security", label: "Security", icon: <KeyRound /> }]
      : [
          { href: "/settings", label: "Brand", icon: <Palette />, exact: true },
          { href: "/settings/members", label: "Team", icon: <Users /> },
          { href: "/settings/domains", label: "Domains", icon: <Globe /> },
          { href: "/settings/templates", label: "Import templates", icon: <Boxes /> },
          { href: "/settings/billing", label: "Billing", icon: <CreditCard /> },
          { href: "/settings/data", label: "Data & audit", icon: <Database /> },
          { href: "/settings/security", label: "Security", icon: <KeyRound /> },
        ];
  return (
    <div className="flex h-full flex-col">
      <div className="relative px-4 pb-2 pt-5">
        <div className="pointer-events-none absolute -top-24 left-0 h-48 w-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-brand)_45%,transparent),transparent)] opacity-60" />
        <Link href="/dashboard" className="relative flex items-center" onClick={onNavigate}>
          <BrandLogo name={org.name} logoUrl={org.logoUrl} dark />
        </Link>
      </div>
      <nav className="scroll-thin flex-1 overflow-y-auto px-3">
        <Section title="Workspace">{work.map((i) => <NavLink key={i.href} item={i} onNavigate={onNavigate} />)}</Section>
        <Section title="Settings">{settings.map((i) => <NavLink key={i.href} item={i} onNavigate={onNavigate} />)}</Section>
        {platformAdmin && (
          <Section title="Platform">
            <NavLink item={{ href: "/admin", label: "Admin console", icon: <ShieldCheck /> }} onNavigate={onNavigate} />
          </Section>
        )}
      </nav>
      <div className="relative border-t border-white/[0.06] p-3">
        {menu && (
          <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-xl bg-ink-2 p-1.5 shadow-float">
            {orgs.length > 1 && (
              <>
                <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">Switch organisation</div>
                {orgs.map((o) => (
                  <button key={o.id} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-white/5", o.id === org.id ? "text-white" : "text-zinc-400")}
                    onClick={async () => { await api("/api/auth/switch-org", { body: { orgId: o.id } }); window.location.href = "/dashboard"; }}>
                    {o.name}
                  </button>
                ))}
                <div className="my-1 h-px bg-white/5" />
              </>
            )}
            <a href="mailto:support@dentosim.cloud" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-zinc-300 hover:bg-white/5"><LifeBuoy className="h-4 w-4" />Help & support</a>
            <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-300 hover:bg-white/5"
              onClick={async () => { await api("/api/auth/logout", { body: {} }); router.replace("/login"); }}>
              <LogOut className="h-4 w-4" />Sign out
            </button>
          </div>
        )}
        <button onClick={() => setMenu((m) => !m)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-white/[0.05]" aria-label="Account menu">
          <Avatar name={user.name} size={32} className="ring-ink" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-zinc-100">{user.name}</span>
            <span className="block truncate text-[11.5px] text-zinc-500">{role === "admin" ? "Lab admin" : role === "technician" ? "Lab technician" : "Doctor"} · {org.name}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 text-zinc-500" />
        </button>
      </div>
    </div>
  );
}

export function Sidebar(p: Props) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] bg-ink lg:block">
        <SidebarBody {...p} />
      </aside>
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/5 bg-ink px-4 lg:hidden">
        <BrandLogo name={p.org.name} logoUrl={p.org.logoUrl} dark />
        <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-zinc-300 hover:bg-white/10" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] bg-ink shadow-float animate-fade-up">
            <button onClick={() => setOpen(false)} className="absolute right-3 top-4 z-10 rounded-lg p-2 text-zinc-400 hover:bg-white/10" aria-label="Close menu"><X className="h-5 w-5" /></button>
            <SidebarBody {...p} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
