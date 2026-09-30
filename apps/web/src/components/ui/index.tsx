import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type BtnVariant = "primary" | "secondary" | "danger" | "ghost";
const btn = (v: BtnVariant = "primary", size: "sm" | "md" = "md") =>
  cx(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
    size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-sm",
    v === "primary" && "bg-brand text-white hover:brightness-110 shadow-sm",
    v === "secondary" && "bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50",
    v === "danger" && "bg-red-600 text-white hover:bg-red-700",
    v === "ghost" && "text-stone-700 hover:bg-stone-100",
  );

export function Button({ variant, size, className, ...p }: ComponentProps<"button"> & { variant?: BtnVariant; size?: "sm" | "md" }) {
  return <button className={cx(btn(variant, size), className)} {...p} />;
}

export function LinkButton({ variant, size, className, ...p }: ComponentProps<typeof Link> & { variant?: BtnVariant; size?: "sm" | "md" }) {
  return <Link className={cx(btn(variant, size), className)} {...p} />;
}

export function Card({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-xl bg-white ring-1 ring-stone-200 shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}

export const inputCls = "block w-full rounded-lg border-0 bg-white px-3 h-10 text-sm ring-1 ring-stone-300 placeholder:text-stone-400 focus:ring-2 focus:ring-brand outline-none";

export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={cx(inputCls, p.className)} />;
}

export function Select(p: ComponentProps<"select">) {
  return <select {...p} className={cx(inputCls, "pr-8", p.className)} />;
}

export function Textarea(p: ComponentProps<"textarea">) {
  return <textarea {...p} className={cx(inputCls, "h-auto py-2", p.className)} />;
}

const TONES = {
  neutral: "bg-stone-100 text-stone-700 ring-stone-200",
  blue: "bg-sky-50 text-sky-800 ring-sky-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>{children}</span>;
}

export const STATUS: Record<string, { label: string; tone: keyof typeof TONES }> = {
  uploading: { label: "Uploading", tone: "neutral" },
  uploaded: { label: "Uploaded", tone: "neutral" },
  processing: { label: "Processing", tone: "blue" },
  needs_mapping: { label: "Needs mapping", tone: "amber" },
  ready_for_review: { label: "Ready for review", tone: "violet" },
  doctor_review: { label: "Doctor review", tone: "blue" },
  changes_requested: { label: "Changes requested", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  published: { label: "Published", tone: "green" },
  patient_viewed: { label: "Patient viewed", tone: "green" },
  superseded: { label: "Superseded", tone: "neutral" },
  failed: { label: "Failed", tone: "red" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 p-10 text-center">
      <p className="font-medium text-stone-800">{title}</p>
      {children && <div className="mt-2 text-sm text-stone-500">{children}</div>}
    </div>
  );
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}
