"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button className="rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100" onClick={async () => { await api("/api/auth/logout", { body: {} }); router.replace("/login"); }}>
      Sign out
    </button>
  );
}

export function StopImpersonation() {
  return (
    <button className="rounded bg-amber-950 px-2 py-0.5 text-xs text-white" onClick={async () => { await api("/api/admin/stop-impersonation", { body: {} }); window.location.href = "/admin"; }}>
      End session
    </button>
  );
}

export function ResendVerification() {
  const [sent, setSent] = useState(false);
  return sent ? <span>Sent.</span> : <button className="underline" onClick={async () => { await api("/api/auth/verify-resend", { body: {} }); setSent(true); }}>Resend</button>;
}

export function OrgSwitcher({ orgs, current }: { orgs: { id: string; name: string }[]; current: string }) {
  return (
    <select className="h-8 rounded-md border-0 bg-stone-100 px-2 text-sm" value={current} aria-label="Organisation"
      onChange={async (e) => { await api("/api/auth/switch-org", { body: { orgId: e.target.value } }); window.location.href = "/dashboard"; }}>
      {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}
