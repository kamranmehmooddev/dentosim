import { redirect } from "next/navigation";
import { getOrg } from "@dentosim/server";
import { Card } from "@/components/ui";
import { BrandingForm } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Settings" };

export default async function OrgSettings() {
  const ctx = await requirePageAuth();
  if (ctx.role === "doctor") redirect("/settings/security");
  const org = await getOrg(ctx.org.id);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Organisation & branding</h1>
      <Card title="Brand">
        {ctx.role === "admin" ? <BrandingForm initial={{ name: org.name, ...org.branding }} /> : <p className="text-sm text-stone-600">Only admins can change branding.</p>}
      </Card>
      <Card title="Preview">
        <div className="flex items-center gap-4 rounded-xl p-4 ring-1 ring-stone-200">
          {org.branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={org.branding.logoUrl} alt="" className="h-10 max-w-[180px] object-contain" />
          ) : <span className="font-semibold text-brand">{org.name}</span>}
          <span className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white">Primary button</span>
          <span className="text-sm text-stone-500">Applies to the app, emails, patient pages and the viewer chrome.</span>
        </div>
      </Card>
    </>
  );
}
