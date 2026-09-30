"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { api } from "@/lib/client";

function useSubmit(fn: (data: Record<string, string>) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await fn(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, onSubmit };
}

const ErrorText = ({ error }: { error: string | null }) => (error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null);

export function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/dashboard";
  const [mfa, setMfa] = useState(false);
  const login = useSubmit(async (d) => {
    const r = await api<{ mfaRequired: boolean }>("/api/auth/login", { body: { email: d.email, password: d.password } });
    if (r.mfaRequired) setMfa(true);
    else router.replace(next.startsWith("/") ? next : "/dashboard");
  });
  const code = useSubmit(async (d) => {
    await api("/api/auth/mfa", { body: { code: d.code } });
    router.replace("/dashboard");
  });
  if (mfa)
    return (
      <form onSubmit={code.onSubmit} className="space-y-4">
        <h1 className="text-lg font-semibold">Two-factor authentication</h1>
        <p className="text-sm text-stone-600">Enter the 6-digit code from your authenticator app.</p>
        <Field label="Code"><Input name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required pattern="\d{6}" /></Field>
        <ErrorText error={code.error} />
        <Button className="w-full" disabled={code.busy}>Verify</Button>
      </form>
    );
  return (
    <form onSubmit={login.onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Sign in</h1>
      <Field label="Email"><Input name="email" type="email" autoComplete="email" required autoFocus /></Field>
      <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required /></Field>
      <ErrorText error={login.error} />
      <Button className="w-full" disabled={login.busy}>{login.busy ? "Signing in…" : "Sign in"}</Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-stone-600 hover:text-stone-900">Forgot password?</Link>
        <Link href="/signup" className="font-medium text-brand">Create account</Link>
      </div>
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const s = useSubmit(async (d) => {
    await api("/api/auth/signup", { body: d });
    router.replace("/dashboard?welcome=1");
  });
  return (
    <form onSubmit={s.onSubmit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Start your free trial</h1>
        <p className="mt-1 text-sm text-stone-600">Branded 3D treatment simulations for your lab. No card required.</p>
      </div>
      <Field label="Company / lab name"><Input name="orgName" required maxLength={120} autoFocus /></Field>
      <Field label="Your name"><Input name="name" required maxLength={120} autoComplete="name" /></Field>
      <Field label="Work email"><Input name="email" type="email" required autoComplete="email" /></Field>
      <Field label="Password" hint="At least 10 characters."><Input name="password" type="password" required minLength={10} autoComplete="new-password" /></Field>
      <ErrorText error={s.error} />
      <Button className="w-full" disabled={s.busy}>{s.busy ? "Creating…" : "Create account"}</Button>
      <p className="text-center text-sm text-stone-600">Already have an account? <Link href="/login" className="font-medium text-brand">Sign in</Link></p>
    </form>
  );
}

export function ForgotForm() {
  const [sent, setSent] = useState(false);
  const s = useSubmit(async (d) => {
    await api("/api/auth/forgot", { body: { email: d.email } });
    setSent(true);
  });
  if (sent) return <p className="text-sm text-stone-700">If an account exists for that email, we sent a link to reset the password. It is valid for one hour.</p>;
  return (
    <form onSubmit={s.onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <Field label="Email"><Input name="email" type="email" required autoFocus /></Field>
      <ErrorText error={s.error} />
      <Button className="w-full" disabled={s.busy}>Send reset link</Button>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const s = useSubmit(async (d) => {
    await api("/api/auth/reset", { body: { token, password: d.password } });
    router.replace("/login?reset=1");
  });
  return (
    <form onSubmit={s.onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <Field label="New password" hint="At least 10 characters."><Input name="password" type="password" minLength={10} required autoFocus /></Field>
      <ErrorText error={s.error} />
      <Button className="w-full" disabled={s.busy}>Save password</Button>
    </form>
  );
}

export function InviteForm({ token, email, orgName, existing }: { token: string; email: string; orgName: string; existing: boolean }) {
  const router = useRouter();
  const s = useSubmit(async (d) => {
    await api("/api/auth/invite", { body: { token, name: d.name, password: d.password } });
    router.replace("/dashboard");
  });
  return (
    <form onSubmit={s.onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Join {orgName}</h1>
      <p className="text-sm text-stone-600">{email}</p>
      {!existing && <Field label="Your name"><Input name="name" required /></Field>}
      <Field label={existing ? "Your password" : "Choose a password"} hint={existing ? undefined : "At least 10 characters."}>
        <Input name="password" type="password" required minLength={existing ? 1 : 10} />
      </Field>
      <ErrorText error={s.error} />
      <Button className="w-full" disabled={s.busy}>Accept invitation</Button>
    </form>
  );
}
