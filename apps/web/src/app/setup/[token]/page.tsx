import { cookies, headers } from "next/headers";
import { AppError, checkPinGrant, resolveShare, ShareUnavailable } from "@dentosim/server";
import { brandStyle } from "@/lib/branding";
import { viewerEngine } from "@/lib/viewer";
import { PatientViewer, PinForm } from "@/components/patient/PatientClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your treatment simulation", robots: { index: false, follow: false } };

export default async function PatientPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ embed?: string }> }) {
  const { token } = await params;
  const embed = (await searchParams).embed === "1";
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  let share;
  try {
    share = await resolveShare(token, ip);
  } catch (e) {
    const msg = e instanceof ShareUnavailable || e instanceof AppError ? e.message : "This link is not valid.";
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="text-lg font-semibold">Simulation unavailable</h1>
          <p className="text-sm text-stone-600" data-testid="share-error">{msg}</p>
        </div>
      </main>
    );
  }
  const b = share.org.branding;
  const pinOk = !share.pinRequired || checkPinGrant(share.linkId, (await cookies()).get(`ds_pin_${share.linkId}`)?.value);
  const viewer = pinOk ? <PatientViewer token={token} engine={viewerEngine()} embed={embed} gumColor={b.gumColor} /> : <PinForm token={token} />;
  if (embed) return <div style={brandStyle(b)}>{viewer}</div>;
  return (
    <div style={brandStyle(b)} className="min-h-dvh bg-stone-50">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          {b.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.logoUrl} alt={share.org.name} className="h-8 max-w-[180px] object-contain" />
          ) : (
            <span className="font-semibold text-brand">{share.org.name}</span>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="patient-title">{b.patientHeadline || "Your Treatment Simulation"}</h1>
          {share.patientName && <p className="text-stone-600">Hello {share.patientName},</p>}
        </div>
        {viewer}
        {share.doctorName && <p className="text-sm text-stone-700" data-testid="prepared-by">Treatment plan prepared by {share.doctorName}.</p>}
        <p className="text-xs text-stone-500">This simulation shows the planned stages of your treatment. Actual results can vary; talk to your doctor about any questions.</p>
      </main>
    </div>
  );
}
