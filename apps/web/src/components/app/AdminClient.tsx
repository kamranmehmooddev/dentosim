"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/client";

/** Audit-logged impersonation (1 h session, reason required). */
export function Impersonate({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Impersonate</Button>;
  return (
    <form className="flex items-center justify-end gap-2" onSubmit={async (e) => {
      e.preventDefault();
      try { await api("/api/admin/impersonate", { body: { orgId, reason } }); window.location.href = "/dashboard"; } catch (x) { setErr((x as Error).message); }
    }}>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (ticket #…)" className="h-8 w-48" required minLength={3} />
      <Button size="sm">Start</Button>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </form>
  );
}
