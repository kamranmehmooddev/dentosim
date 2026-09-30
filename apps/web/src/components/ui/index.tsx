/**
 * DentoSim UI kit — calm, precise surfaces: hairline borders, layered shadows,
 * Geist type, tabular numerals, one brand accent.
 */
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// ───────────────────────── buttons ─────────────────────────

type BtnVariant = "primary" | "secondary" | "danger" | "ghost" | "dark";
type BtnSize = "sm" | "md" | "lg";

export const btnCls = (v: BtnVariant = "primary", size: BtnSize = "md") =>
  cx(
    "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium tracking-[-0.01em] transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
    size === "sm" && "h-8 px-3 text-[13px]",
    size === "md" && "h-10 px-4 text-sm",
    size === "lg" && "h-12 px-5 text-[15px]",
    v === "primary" &&
      "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.12),0_4px_14px_-4px_color-mix(in_oklab,var(--color-brand)_60%,transparent)] hover:brightness-[1.08]",
    v === "dark" && "bg-ink text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_1px_2px_rgb(0_0_0/0.2)] hover:bg-ink-2",
    v === "secondary" && "bg-white text-zinc-800 shadow-card hover:bg-zinc-50 hover:text-zinc-950",
    v === "danger" && "bg-red-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.15)] hover:bg-red-700",
    v === "ghost" && "text-zinc-600 hover:bg-zinc-900/[0.05] hover:text-zinc-950",
  );

export function Button({ variant, size, className, ...p }: ComponentProps<"button"> & { variant?: BtnVariant; size?: BtnSize }) {
  return <button className={cx(btnCls(variant, size), className)} {...p} />;
}

export function LinkButton({ variant, size, className, ...p }: ComponentProps<typeof Link> & { variant?: BtnVariant; size?: BtnSize }) {
  return <Link className={cx(btnCls(variant, size), className)} {...p} />;
}

// ───────────────────────── surfaces ─────────────────────────

export function Card({ className, children, title, description, actions, icon, padded = true }: {
  className?: string; children: ReactNode; title?: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode; padded?: boolean;
}) {
  return (
    <section className={cx("rounded-2xl bg-white shadow-card", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 pb-1 pt-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-900">{title}</h2>
              {description && <p className="mt-0.5 text-[12.5px] text-zinc-500">{description}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={padded ? "p-5 pt-3" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ eyebrow, title, description, actions, children }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-[12.5px] font-medium text-zinc-500">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-zinc-950">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-zinc-500">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone = "neutral" }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: "neutral" | "brand" | "amber" | "violet" }) {
  const toneCls = {
    neutral: "bg-zinc-100 text-zinc-600",
    brand: "bg-brand/10 text-brand",
    amber: "bg-amber-100 text-amber-700",
    violet: "bg-violet-100 text-violet-700",
  }[tone];
  return (
    <div className="group relative overflow-hidden rounded-2xl bg-white p-4 shadow-card transition hover:shadow-raised">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-zinc-500">{label}</span>
        {icon && <span className={cx("flex h-7 w-7 items-center justify-center rounded-lg [&>svg]:h-3.5 [&>svg]:w-3.5", toneCls)}>{icon}</span>}
      </div>
      <div className="mt-3 text-[28px] font-semibold leading-none tracking-[-0.03em] text-zinc-950 tabular">{value}</div>
      {hint && <div className="mt-2 text-[12px] text-zinc-500">{hint}</div>}
    </div>
  );
}

// ───────────────────────── forms ─────────────────────────

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-zinc-800">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-snug text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "block w-full h-10 rounded-[10px] border-0 bg-white px-3 text-[14px] text-zinc-900 shadow-[0_1px_2px_rgb(16_24_40/0.04)] ring-1 ring-inset ring-zinc-200 placeholder:text-zinc-400 transition focus:ring-2 focus:ring-brand/60 outline-none disabled:bg-zinc-50";

export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={cx(inputCls, p.className)} />;
}

export function Select(p: ComponentProps<"select">) {
  return (
    <select
      {...p}
      className={cx(
        inputCls,
        "appearance-none bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")] bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-9",
        p.className,
      )}
    />
  );
}

export function Textarea(p: ComponentProps<"textarea">) {
  return <textarea {...p} className={cx(inputCls, "h-auto py-2.5 leading-relaxed", p.className)} />;
}

// ───────────────────────── status ─────────────────────────

const TONES = {
  neutral: { pill: "bg-zinc-100 text-zinc-700 ring-zinc-200/80", dot: "bg-zinc-400" },
  blue: { pill: "bg-sky-50 text-sky-800 ring-sky-200/80", dot: "bg-sky-500" },
  amber: { pill: "bg-amber-50 text-amber-800 ring-amber-200/80", dot: "bg-amber-500" },
  green: { pill: "bg-emerald-50 text-emerald-800 ring-emerald-200/80", dot: "bg-emerald-500" },
  red: { pill: "bg-red-50 text-red-700 ring-red-200/80", dot: "bg-red-500" },
  violet: { pill: "bg-violet-50 text-violet-800 ring-violet-200/80", dot: "bg-violet-500" },
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children, dot = false, pulse = false }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11.5px] font-medium ring-1 ring-inset", TONES[tone].pill)}>
      {dot && <span className={cx("h-1.5 w-1.5 rounded-full", TONES[tone].dot, pulse && "animate-pulse-ring")} />}
      {children}
    </span>
  );
}

export const STATUS: Record<string, { label: string; tone: Tone }> = {
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
  return <Badge tone={s.tone} dot pulse={status === "processing"}>{s.label}</Badge>;
}

// ───────────────────────── misc ─────────────────────────

const AVATAR_TONES = ["from-teal-500 to-emerald-600", "from-indigo-500 to-violet-600", "from-sky-500 to-blue-600", "from-rose-500 to-pink-600", "from-amber-500 to-orange-600", "from-fuchsia-500 to-purple-600"];

export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  const initials = name.replace(/^(dr\.?|prof\.?)\s+/i, "").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white ring-2 ring-white", AVATAR_TONES[h % AVATAR_TONES.length], className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

export function Empty({ title, children, icon, action }: { title: string; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white px-6 py-14 text-center shadow-card">
      <div className="bg-grid-light pointer-events-none absolute inset-0 [mask-image:radial-gradient(60%_60%_at_50%_40%,black,transparent)]" />
      <div className="relative">
        {icon && <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-brand shadow-raised [&>svg]:h-5 [&>svg]:w-5">{icon}</div>}
        <p className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-900">{title}</p>
        {children && <div className="mx-auto mt-1.5 max-w-sm text-[13.5px] text-zinc-500">{children}</div>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10.5px] text-white/70 ring-1 ring-inset ring-white/15">{children}</kbd>;
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-px bg-zinc-100", className)} />;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtDay(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function relTime(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "—";
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return fmtDay(d);
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}
