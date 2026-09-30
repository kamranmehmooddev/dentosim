import { cx } from "@/components/ui";

/** Platform mark (used when a tenant has no logo). */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cx("h-7 w-7", className)} aria-hidden>
      <defs>
        <linearGradient id="dsm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-brand-2)" />
          <stop offset="1" stopColor="var(--color-brand)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#dsm)" />
      <path d="M20 18c-5 0-8 4-7.5 10 .6 7 3 11 4.5 18 .8 3.6 4.6 3.8 5.6.3l2.4-8.6c.8-2.6 4.2-2.6 5 0l2.4 8.6c1 3.5 4.8 3.3 5.6-.3 1.5-7 3.9-11 4.5-18C52 22 49 18 44 18c-4 0-6 2-12 2s-8-2-12-2Z" fill="white" fillOpacity=".95" />
    </svg>
  );
}

export function BrandLogo({ name, logoUrl, dark = false, className }: { name: string; logoUrl?: string; dark?: boolean; className?: string }) {
  if (logoUrl)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={name} className={cx("h-7 max-w-[160px] object-contain", className)} />;
  return (
    <span className={cx("flex items-center gap-2.5", className)}>
      <Mark />
      <span className={cx("text-[15px] font-semibold tracking-[-0.02em]", dark ? "text-white" : "text-zinc-950")}>{name}</span>
    </span>
  );
}
