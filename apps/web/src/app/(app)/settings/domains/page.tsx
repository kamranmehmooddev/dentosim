import { config, listDomains } from "@dentosim/server";
import { Badge, Card } from "@/components/ui";
import { ActionButton, DomainForm } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Domains" };

export default async function Domains() {
  const ctx = await requirePageAuth();
  const domains = await listDomains(ctx.org.id);
  const ingress = new URL(config().APP_URL).host;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Domains</h1>
      <Card title="Your addresses">
        <ul className="divide-y divide-stone-100 text-sm">
          {domains.map((d) => (
            <li key={d.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-medium">{d.hostname}</code>
                <Badge tone={d.verifiedAt ? "green" : "amber"}>{d.verifiedAt ? "active" : "pending verification"}</Badge>
                <Badge>{d.kind}</Badge>
                <span className="flex-1" />
                {d.kind === "custom" && !d.verifiedAt && ctx.role === "admin" && <ActionButton url={`/api/org/domains/${d.id}/verify`}>Verify</ActionButton>}
                {d.kind === "custom" && ctx.role === "admin" && <ActionButton url={`/api/org/domains/${d.id}`} method="DELETE" variant="ghost" confirmText={`Remove ${d.hostname}?`}>Remove</ActionButton>}
              </div>
              {d.kind === "custom" && !d.verifiedAt && (
                <div className="rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
                  <p>1. Add a <strong>CNAME</strong> record: <code>{d.hostname}</code> → <code>{ingress}</code></p>
                  <p>2. Add a <strong>TXT</strong> record: <code>_dentosim.{d.hostname}</code> = <code>{d.verificationToken}</code></p>
                  <p>3. Click Verify. HTTPS certificates are issued automatically once the domain points to us.</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {ctx.role === "admin" && <Card title="Add a custom domain"><DomainForm /></Card>}
    </>
  );
}
