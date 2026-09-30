"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/client";

function useForm<T extends Record<string, string>>(submit: (d: T) => Promise<unknown>, after?: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await submit(Object.fromEntries(new FormData(e.currentTarget)) as T);
      setMsg({ ok: true, text: "Saved." });
      after?.();
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, onSubmit };
}

const Msg = ({ m }: { m: { ok: boolean; text: string } | null }) => (m ? <p role="status" className={`text-sm ${m.ok ? "text-emerald-700" : "text-red-700"}`}>{m.text}</p> : null);

export function BrandingForm({ initial }: { initial: Record<string, string | undefined> & { name: string } }) {
  const f = useForm((d) => api("/api/org/branding", { body: d }));
  const [primary, setPrimary] = useState(initial.primaryColor ?? "#0f766e");
  const [logoMsg, setLogoMsg] = useState<string | null>(null);
  const upload = async (kind: "logo" | "favicon", file: File | undefined) => {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("kind", kind);
    const r = await fetch("/api/org/logo", { method: "POST", body: fd });
    const j = await r.json();
    setLogoMsg(r.ok ? `${kind === "logo" ? "Logo" : "Favicon"} updated.` : j.error);
    if (r.ok) window.location.reload();
  };
  return (
    <div className="space-y-6">
      <form onSubmit={f.onSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Organisation name"><Input name="name" defaultValue={initial.name} required /></Field>
        <Field label="Email sender name" hint="Shown as the From name of notification emails."><Input name="emailFromName" defaultValue={initial.emailFromName} /></Field>
        <Field label="Primary colour">
          <div className="flex gap-2"><input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} className="h-10 w-12 rounded" aria-label="Primary colour picker" /><Input name="primaryColor" value={primary} onChange={(e) => setPrimary(e.target.value)} pattern="#[0-9a-fA-F]{6}" /></div>
        </Field>
        <Field label="Secondary colour"><Input name="secondaryColor" defaultValue={initial.secondaryColor} placeholder="#134e4a" pattern="#[0-9a-fA-F]{6}" /></Field>
        <Field label="Font family" hint="A CSS font stack, e.g. Inter, sans-serif"><Input name="fontFamily" defaultValue={initial.fontFamily} /></Field>
        <Field label="Default gum colour (viewer)"><Input name="gumColor" defaultValue={initial.gumColor} placeholder="#d98a8f" pattern="#[0-9a-fA-F]{6}" /></Field>
        <Field label="Patient page headline"><Input name="patientHeadline" defaultValue={initial.patientHeadline} placeholder="Your Treatment Simulation" /></Field>
        <Field label="Logo URL (https) — or upload below"><Input name="logoUrl" defaultValue={initial.logoUrl} /></Field>
        <div className="flex items-center gap-3 sm:col-span-2"><Button disabled={f.busy}>Save branding</Button><Msg m={f.msg} /></div>
      </form>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="cursor-pointer rounded-lg px-3 py-2 ring-1 ring-stone-300 hover:bg-stone-50">Upload logo<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="sr-only" onChange={(e) => upload("logo", e.target.files?.[0])} /></label>
        <label className="cursor-pointer rounded-lg px-3 py-2 ring-1 ring-stone-300 hover:bg-stone-50">Upload favicon<input type="file" accept="image/png,image/x-icon,image/svg+xml" className="sr-only" onChange={(e) => upload("favicon", e.target.files?.[0])} /></label>
        {logoMsg && <span className="self-center text-stone-600">{logoMsg}</span>}
      </div>
    </div>
  );
}

export function InviteForm() {
  const f = useForm((d) => api("/api/org/members", { body: d }));
  return (
    <form onSubmit={f.onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Email"><Input name="email" type="email" required className="w-72" /></Field>
      <Field label="Role">
        <Select name="role" defaultValue="technician" className="w-44">
          <option value="technician">Lab technician</option>
          <option value="doctor">Doctor</option>
          <option value="admin">Lab admin</option>
        </Select>
      </Field>
      <Button disabled={f.busy}>Send invitation</Button>
      <Msg m={f.msg} />
    </form>
  );
}

export function ActionButton({ url, method = "POST", confirmText, children, variant = "secondary" }: { url: string; method?: string; confirmText?: string; children: ReactNode; variant?: "secondary" | "danger" | "ghost" | "primary" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant={variant} disabled={busy} onClick={async () => {
        if (confirmText && !confirm(confirmText)) return;
        setBusy(true);
        setErr(null);
        try {
          const r = await api<{ url?: string }>(url, { method, body: method === "DELETE" ? undefined : {} });
          if (r?.url) window.location.href = r.url;
          router.refresh();
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{children}</Button>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </span>
  );
}

export function DomainForm() {
  const f = useForm((d) => api("/api/org/domains", { body: d }));
  return (
    <form onSubmit={f.onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Custom domain"><Input name="hostname" placeholder="app.yourcompany.com" required className="w-72" /></Field>
      <Button disabled={f.busy}>Add domain</Button>
      <Msg m={f.msg} />
    </form>
  );
}

export function RetentionForm({ days }: { days: number | null }) {
  const f = useForm((d) => api("/api/org/retention", { body: { days: d.days ? Number(d.days) : null } }));
  return (
    <form onSubmit={f.onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Delete cases after (days of inactivity)" hint="Leave empty to keep cases until you delete them. Minimum 30 days.">
        <Input name="days" type="number" min={30} max={3650} defaultValue={days ?? ""} className="w-40" />
      </Field>
      <Button disabled={f.busy}>Save</Button>
      <Msg m={f.msg} />
    </form>
  );
}

export function ClinicForm() {
  const f = useForm((d) => api("/api/org/clinics", { body: d }));
  return (
    <form onSubmit={f.onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="New clinic"><Input name="name" required className="w-72" /></Field>
      <Button disabled={f.busy}>Add clinic</Button>
      <Msg m={f.msg} />
    </form>
  );
}

export function TotpSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const confirmForm = useForm<{ code: string }>((d) => api("/api/auth/totp/confirm", { body: d }), () => setSetup(null));
  const disableForm = useForm<{ password: string; code: string }>((d) => api("/api/auth/totp/disable", { body: d }));
  if (enabled)
    return (
      <form onSubmit={disableForm.onSubmit} className="flex flex-wrap items-end gap-3">
        <p className="w-full text-sm text-emerald-700">Two-factor authentication is on.</p>
        <Field label="Password"><Input name="password" type="password" required /></Field>
        <Field label="Current code"><Input name="code" inputMode="numeric" required className="w-32" /></Field>
        <Button variant="secondary" disabled={disableForm.busy}>Turn off</Button>
        <Msg m={disableForm.msg} />
      </form>
    );
  if (!setup)
    return (
      <div className="space-y-2">
        <p className="text-sm text-stone-600">Protect your account with an authenticator app (TOTP).</p>
        <Button onClick={async () => { try { setSetup(await api("/api/auth/totp/begin", { body: {} })); } catch (e) { setMsg((e as Error).message); } }}>Set up two-factor authentication</Button>
        {msg && <p className="text-sm text-red-700">{msg}</p>}
      </div>
    );
  return (
    <form onSubmit={confirmForm.onSubmit} className="space-y-3">
      <p className="text-sm text-stone-600">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={setup.qr} alt="TOTP QR code" width={200} height={200} />
      <p className="text-xs text-stone-500">Or enter the key manually: <code>{setup.secret}</code></p>
      <div className="flex items-end gap-3">
        <Field label="Code"><Input name="code" inputMode="numeric" required className="w-32" /></Field>
        <Button disabled={confirmForm.busy}>Confirm</Button>
      </div>
      <Msg m={confirmForm.msg} />
    </form>
  );
}
