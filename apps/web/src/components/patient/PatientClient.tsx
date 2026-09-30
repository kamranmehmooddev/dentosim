"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { Viewer, type ViewerProps } from "@/components/viewer/Viewer";
import { api } from "@/lib/client";

export function PatientViewer({ token, engine, embed, gumColor }: { token: string; engine: ViewerProps["engine"]; embed: boolean; gumColor?: string }) {
  const [shared, setShared] = useState(false);
  let first = true;
  const loadUrls = async () => {
    const r = await api<{ files: Record<string, string> }>(`/api/public/setup/${token}/package${first ? "" : "?refresh=1"}`);
    first = false;
    return r.files;
  };
  const share = async () => {
    const url = window.location.href.replace(/\?.*$/, "");
    if (navigator.share) await navigator.share({ title: "My treatment simulation", url }).catch(() => undefined);
    else { await navigator.clipboard.writeText(url); setShared(true); }
  };
  return (
    <div className="space-y-3">
      <Viewer engine={engine} mode="patient" embed={embed} gumColor={gumColor} loadUrls={loadUrls} className={embed ? "" : "h-[70dvh] min-h-[420px]"} />
      {!embed && (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={share}>{shared ? "Link copied" : "Share"}</Button>
        </div>
      )}
    </div>
  );
}

export function PinForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mx-auto max-w-xs space-y-3 rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-stone-200"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/api/public/setup/${token}/pin`, { body: { pin: String(new FormData(e.currentTarget).get("pin") ?? "") } });
          window.location.reload();
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <p className="font-medium">Enter your PIN</p>
      <p className="text-sm text-stone-600">Your practice gave you a PIN to open this simulation.</p>
      <Input name="pin" inputMode="numeric" autoComplete="one-time-code" pattern="\d{4,8}" required autoFocus className="text-center text-lg tracking-widest" aria-label="PIN" />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Button className="w-full" disabled={busy}>Open</Button>
    </form>
  );
}
