import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppError, getCaseDetail } from "@dentosim/server";
import { MappingScreen } from "@/components/app/MappingScreen";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Map files" };

export default async function MappingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ revision?: string }> }) {
  const ctx = await requirePageAuth();
  if (ctx.role === "doctor") redirect("/dashboard");
  const { id } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await getCaseDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const rev = d.revisions.find((r) => r.id === sp.revision) ?? d.revisions.find((r) => r.status === "needs_mapping");
  if (!rev || rev.status !== "needs_mapping" || !rev.mappingProposal) redirect(`/cases/${id}`);
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/cases/${id}`} className="text-sm text-stone-500 hover:text-stone-800">← Case #{d.case.caseNumber}</Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Map the exported files</h1>
        <p className="mt-1 max-w-3xl text-sm text-stone-600">
          Tell us what each file is. Your answers are saved as a template for this organisation, so the next export from the same software is recognised automatically.
        </p>
      </div>
      {rev.mappingProposal.reasons.length > 0 && (
        <ul className="list-disc space-y-1 rounded-xl bg-amber-50 p-4 pl-8 text-sm text-amber-900 ring-1 ring-amber-200">
          {rev.mappingProposal.reasons.slice(0, 8).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <MappingScreen caseId={id} revisionId={rev.id} entries={rev.mappingProposal.entries} />
    </div>
  );
}
