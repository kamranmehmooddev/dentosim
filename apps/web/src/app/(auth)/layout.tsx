import { currentTenant } from "@/lib/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await currentTenant();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          {t?.branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.branding.logoUrl} alt={t.name} className="h-10 max-w-[200px] object-contain" />
          ) : (
            <span className="text-xl font-semibold tracking-tight text-brand">{t?.name ?? "DentoSim"}</span>
          )}
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-stone-200 sm:p-8">{children}</div>
      </div>
    </main>
  );
}
