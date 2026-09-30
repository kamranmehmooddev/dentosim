import { notFound } from "next/navigation";
import { adminOrgs, adminProblemJobs } from "@dentosim/server";
import { Badge, Card, fmtDate } from "@/components/ui";
import { ActionButton } from "@/components/app/settings-client";
import { Impersonate } from "@/components/app/AdminClient";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Admin" };

export default async function Admin() {
  const ctx = await requirePageAuth();
  if (!ctx.user.isPlatformAdmin || ctx.impersonatorUserId) notFound();
  const [orgs, jobs] = await Promise.all([adminOrgs(ctx), adminProblemJobs(ctx)]);
  // aggregate detection scores of failed/needs-mapping jobs → which adapters to build next
  const seen = new Map<string, number>();
  for (const j of jobs) for (const d of (j.detection as { adapter: string; confidence: number }[] | null) ?? []) seen.set(d.adapter, (seen.get(d.adapter) ?? 0) + 1);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Platform admin</h1>
      <Card title={`Organisations (${orgs.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-stone-500"><tr><th className="py-1">Name</th><th>Plan</th><th>Cases</th><th>Processed (month / total)</th><th>Members</th><th>Created</th><th /></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td className="py-2 font-medium">{o.name} <span className="text-xs text-stone-400">{o.slug}</span></td>
                  <td><Badge tone={o.subscriptionStatus === "active" ? "green" : "neutral"}>{o.subscriptionStatus ?? "—"}</Badge></td>
                  <td className="tabular">{o.cases}</td>
                  <td className="tabular">{o.processedThisMonth} / {o.processedCases}</td>
                  <td className="tabular">{o.members}</td>
                  <td className="text-xs text-stone-500">{fmtDate(o.createdAt)}</td>
                  <td className="text-right"><Impersonate orgId={o.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={`Failed / needs-mapping jobs (${jobs.length})`}>
        <p className="mb-3 text-xs text-stone-500">Detection scores show which formats are arriving without a matching adapter — use them to prioritise new vendor adapters (samples required).</p>
        <ul className="divide-y divide-stone-100 text-sm">
          {jobs.map((j) => (
            <li key={j.jobId} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={j.status === "failed" ? "red" : "amber"}>{j.status}</Badge>
              <span className="font-medium">{j.orgName} · case #{j.caseNumber}</span>
              <span className="text-stone-500">{j.errorCode ? `${j.errorCode}: ${j.error}` : ""}</span>
              <span className="text-xs text-stone-500">{((j.detection as { adapter: string; confidence: number }[] | null) ?? []).map((d) => `${d.adapter} ${d.confidence.toFixed(2)}`).join(" · ")}</span>
              <span className="flex-1" />
              <span className="text-xs text-stone-400">{fmtDate(j.createdAt)} · {j.attempts} attempt(s)</span>
              <ActionButton url={`/api/admin/revisions/${j.revisionId}/retry`}>Retry</ActionButton>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
