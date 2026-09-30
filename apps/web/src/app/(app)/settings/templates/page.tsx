import { listTemplates } from "@dentosim/server";
import { Card, Empty, fmtDate } from "@/components/ui";
import { ActionButton } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Import templates" };

export default async function Templates() {
  const ctx = await requirePageAuth();
  const rows = await listTemplates(ctx);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Import templates</h1>
      <p className="text-sm text-stone-600">Saved from the mapping screen. Exports whose files match a template are imported automatically.</p>
      {rows.length === 0 ? <Empty title="No templates yet">They appear after you confirm a file mapping.</Empty> : (
        <Card>
          <ul className="divide-y divide-stone-100 text-sm">
            {rows.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-medium">{t.name}</span>
                <span className="text-stone-500">{t.software ?? "unknown software"} · {(t.template as unknown as { rules: unknown[] }).rules.length} rules · used {t.timesUsed}× · {fmtDate(t.createdAt)}</span>
                <span className="flex-1" />
                <ActionButton url={`/api/templates/${t.id}`} method="DELETE" variant="ghost" confirmText="Delete this template?">Delete</ActionButton>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
