import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppError, getCaseDetail, getOrg, listDoctors, listShareLinks } from "@dentosim/server";
import { Card, StatusBadge } from "@/components/ui";
import { FitStats, RevisionHistory, Warnings } from "@/components/app/CaseSummary";
import { AssignDoctor, CaseViewer, Comments, LabActions, ProcessingStatus, SharePanel } from "@/components/app/case-client";
import { requirePageAuth } from "@/lib/session";
import { viewerEngine } from "@/lib/viewer";

export const metadata = { title: "Case" };

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ revision?: string }> }) {
  const ctx = await requirePageAuth();
  const { id } = await params;
  if (ctx.role === "doctor") redirect(`/doctor/cases/${id}`);
  const sp = await searchParams;
  let d;
  try {
    d = await getCaseDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const rev = d.revisions.find((r) => r.id === sp.revision) ?? d.revisions.find((r) => r.id === d.case.currentRevisionId) ?? d.revisions[0] ?? null;
  const [doctors, shares, org] = await Promise.all([listDoctors(ctx.org.id), listShareLinks(ctx, id), getOrg(ctx.org.id)]);
  const revNumber = new Map(d.revisions.map((r) => [r.id, r.number]));
  const canShare = rev && (rev.status === "approved" || rev.status === "published");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/dashboard" className="text-sm text-stone-500 hover:text-stone-800">← Cases</Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            Case #{d.case.caseNumber} <StatusBadge status={d.case.status} />
          </h1>
          <p className="text-sm text-stone-600">Patient {d.patient.reference}{d.case.sourceSoftware ? ` · ${d.case.sourceSoftware}` : ""}</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-stone-600">
          Doctor <AssignDoctor caseId={id} current={d.case.doctorUserId} doctors={doctors.map((x) => ({ id: x.userId, name: x.name }))} />
        </div>
      </div>

      <LabActions caseId={id} revisionId={rev?.id ?? null} status={rev?.status ?? null} hasDoctor={!!d.case.doctorUserId} isAdmin={ctx.role === "admin"} />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          {!rev && <Card><p className="text-sm text-stone-600">No export uploaded yet.</p></Card>}
          {rev && ["processing", "uploaded"].includes(rev.status) && <Card title={`Revision ${rev.number}`}><ProcessingStatus revisionId={rev.id} initialStatus={rev.status} /></Card>}
          {rev?.status === "uploading" && <Card title={`Revision ${rev.number}`}><p className="text-sm text-stone-600">Upload in progress or interrupted. Use “Upload new revision” and select the same files to resume.</p></Card>}
          {rev?.status === "needs_mapping" && (
            <Card title="Needs file mapping">
              <p className="mb-2 text-sm text-stone-700">Some files could not be identified automatically:</p>
              <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-stone-600">{rev.mappingProposal?.reasons.slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}</ul>
              <Link href={`/cases/${id}/mapping?revision=${rev.id}`} className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-white" data-testid="open-mapping">Map files</Link>
            </Card>
          )}
          {rev?.status === "failed" && (
            <Card title="Processing failed"><p className="text-sm text-red-700" data-testid="failure-reason">{rev.failureReason}</p></Card>
          )}
          {rev?.packagePrefix && rev.summary && (
            <>
              <CaseViewer revisionId={rev.id} engine={viewerEngine()} gumColor={org.branding.gumColor} />
              <div className="grid gap-6 md:grid-cols-2">
                <Card title="Registration & processing"><FitStats summary={rev.summary} /></Card>
                <Card title="Warnings"><Warnings summary={rev.summary} /></Card>
              </div>
            </>
          )}
          {canShare && (
            <Card title="Patient sharing">
              <SharePanel caseId={id} revisionId={rev!.id} shares={shares.filter((s) => s.revisionId === rev!.id)} />
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Revisions">
            <RevisionHistory caseNumber={d.case.caseNumber} revisions={d.revisions} approvals={d.approvals} currentId={rev?.id ?? null} hrefFor={(r) => `/cases/${id}?revision=${r}`} />
          </Card>
          <Card title="Notes">
            <Comments caseId={id} revisionId={rev?.id ?? null} comments={d.comments.map((c) => ({ ...c, revisionNumber: c.revisionId ? revNumber.get(c.revisionId) : null }))} />
          </Card>
        </div>
      </div>
    </div>
  );
}
