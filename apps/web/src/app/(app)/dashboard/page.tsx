import Link from "next/link";
import { billingStatus, listCases, sourceSoftwareOptions } from "@dentosim/server";
import { Card, Empty, fmtDate, Input, LinkButton, Select, STATUS, StatusBadge } from "@/components/ui";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Cases" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; software?: string; welcome?: string }> }) {
  const ctx = await requirePageAuth();
  const sp = await searchParams;
  const [rows, software, billing] = await Promise.all([listCases(ctx, sp), sourceSoftwareOptions(ctx), billingStatus(ctx.org.id)]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
          <p className="text-sm text-stone-600">{ctx.org.name}</p>
        </div>
        {ctx.role !== "doctor" && <LinkButton href="/cases/new">New case</LinkButton>}
      </div>
      {sp.welcome && (
        <div className="rounded-xl bg-brand/10 p-4 text-sm text-stone-800 ring-1 ring-brand/20">
          Welcome! Create your first case and upload an export from any planning software. Brand your workspace under <Link href="/settings" className="font-medium underline">Settings</Link>.
        </div>
      )}
      {!billing.canProcess && (
        <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          {billing.reason} <Link href="/settings/billing" className="font-medium underline">Billing</Link>
        </div>
      )}
      <form className="grid gap-2 sm:grid-cols-[1fr_200px_200px_auto]" role="search">
        <Input name="q" defaultValue={sp.q} placeholder="Search patient reference or case #" aria-label="Search" />
        <Select name="status" defaultValue={sp.status ?? ""} aria-label="State">
          <option value="">All states</option>
          {Object.entries(STATUS).filter(([k]) => !["uploading", "superseded"].includes(k)).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Select name="software" defaultValue={sp.software ?? ""} aria-label="Source software">
          <option value="">All software</option>
          {software.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <button className="h-10 rounded-lg bg-stone-800 px-4 text-sm font-medium text-white">Filter</button>
      </form>
      {rows.length === 0 ? (
        <Empty title={sp.q || sp.status || sp.software ? "No cases match these filters" : "No cases yet"}>
          {ctx.role !== "doctor" && !sp.q && <Link href="/cases/new" className="font-medium text-brand">Create the first case</Link>}
        </Empty>
      ) : (
        <Card className="overflow-hidden [&>div]:p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                <tr><th className="px-4 py-2">Case</th><th className="px-4 py-2">Patient</th><th className="px-4 py-2">State</th><th className="px-4 py-2">Source software</th><th className="px-4 py-2">Doctor</th><th className="px-4 py-2">Updated</th></tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-stone-50">
                    <td className="px-4 py-2.5 font-medium"><Link href={ctx.role === "doctor" ? `/doctor/cases/${r.id}` : `/cases/${r.id}`} className="text-brand hover:underline">#{r.caseNumber}</Link></td>
                    <td className="px-4 py-2.5">{r.patientRef}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-2.5 text-stone-600">{r.sourceSoftware ?? "—"}</td>
                    <td className="px-4 py-2.5 text-stone-600">{r.doctorName ?? "—"}</td>
                    <td className="px-4 py-2.5 text-stone-500 tabular">{fmtDate(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
