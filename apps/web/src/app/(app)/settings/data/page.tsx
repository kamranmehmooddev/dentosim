import { getOrg, listAudit } from "@dentosim/server";
import { Card, fmtDate } from "@/components/ui";
import { RetentionForm } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Data & retention" };

export default async function DataSettings() {
  const ctx = await requirePageAuth();
  const [org, log] = await Promise.all([getOrg(ctx.org.id), ctx.role === "admin" ? listAudit(ctx.org.id, { limit: 100 }) : Promise.resolve([])]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Data & retention</h1>
      <Card title="Retention">
        {ctx.role === "admin" ? <RetentionForm days={org.retentionDays} /> : <p className="text-sm">Retention: {org.retentionDays ? `${org.retentionDays} days` : "keep until deleted"}</p>}
        <p className="mt-3 text-xs text-stone-500">Expired cases are permanently deleted every night: database records, uploads, packages and share links. Deleting a case from its page does the same immediately.</p>
      </Card>
      {ctx.role === "admin" && (
        <Card title="Audit log (latest 100)">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-stone-500"><tr><th className="py-1 pr-3">Time</th><th className="pr-3">Actor</th><th className="pr-3">Action</th><th>Target</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {log.map((l) => (
                  <tr key={l.id}><td className="py-1 pr-3 tabular">{fmtDate(l.createdAt)}</td><td className="pr-3">{l.actorType}{l.impersonatorUserId ? " (support)" : ""}</td><td className="pr-3 font-mono">{l.action}</td><td className="font-mono text-stone-500">{l.targetType ? `${l.targetType}:${l.targetId?.slice(0, 8)}` : ""}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
