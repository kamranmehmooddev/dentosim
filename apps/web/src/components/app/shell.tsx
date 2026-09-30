"use client";

import { useState } from "react";
import { api } from "@/lib/client";

export function StopImpersonation() {
  return (
    <button className="rounded-md bg-amber-950 px-2.5 py-1 text-xs font-medium text-white" onClick={async () => { await api("/api/admin/stop-impersonation", { body: {} }); window.location.href = "/admin"; }}>
      End session
    </button>
  );
}

export function ResendVerification() {
  const [sent, setSent] = useState(false);
  return sent ? <span className="font-medium">Sent — check your inbox.</span> : <button className="font-medium underline underline-offset-2" onClick={async () => { await api("/api/auth/verify-resend", { body: {} }); setSent(true); }}>Resend link</button>;
}
