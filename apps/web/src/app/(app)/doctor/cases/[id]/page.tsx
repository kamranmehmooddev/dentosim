import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getCaseDetail, getOrg, listShareLinks } from "@dentosim/server";
import { Card, StatusBadge } from "@/components/ui";
import { FitStats, RevisionHistory, Warnings } from "@/components/app/CaseSummary";
import { CaseViewer, Comments, DoctorDecision, SharePanel } from "@/components/app/case-client";
import { requirePageAuth } from "@/lib/session";
import { viewerEngine } from "@/lib/viewer";

export const metadata = { title: "Case review" };

/** Doctor portal: /doctor/cases/{caseId} */
export default async function DoctorCase({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ revision?: string }> }) {
  const ctx = await requirePageAuth();
  const { id } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await getCaseDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  // doctors review processed revisions only
  const visible = d.revisions.filter((r) => r.packagePrefix);
  const rev = visible.find((r) => r.id === sp.revision) ?? visible.find((r) => r.status === "doctor_review") ?? visible[0] ?? null;
  const [shares, org] = await Promise.all([listShareLinks(ctx, id), getOrg(ctx.org.id)]);
  const revNumber = new Map(d.revisions.map((r) => [r.id, r.number]));
  const canDecide = rev?.status === "doctor_review" && (ctx.role === "doctor" || ctx.role === "admin") && !ctx.impersonatorUserId;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-stone-500 hover:text-stone-800">← My cases</Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">Case #{d.case.caseNumber} <StatusBadge status={d.case.status} /></h1>
        <p className="text-sm text-stone-600">Patient {d.patient.reference}</p>
      </div>
      {!rev ? (
        <Card><p className="text-sm text-stone-600">The lab has not shared a simulation for this case yet.</p></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            <CaseViewer revisionId={rev.id} engine={viewerEngine()} gumColor={org.branding.gumColor} />
            {canDecide && <Card title="Your decision"><DoctorDecision revisionId={rev.id} revisionNumber={rev.number} /></Card>}
            {rev.summary && (
              <div className="grid gap-6 md:grid-cols-2">
                <Card title="Registration fit"><FitStats summary={rev.summary} /></Card>
                <Card title="Notes from processing"><Warnings summary={rev.summary} /></Card>
              </div>
            )}
            {(rev.status === "approved" || rev.status === "published") && (
              <Card title="Share with the patient">
                <SharePanel caseId={id} revisionId={rev.id} shares={shares.filter((s) => s.revisionId === rev.id)} />
              </Card>
            )}
          </div>
          <div className="space-y-6">
            <Card title="Revision history">
              <RevisionHistory caseNumber={d.case.caseNumber} revisions={visible} approvals={d.approvals} currentId={rev.id} hrefFor={(r) => `/doctor/cases/${id}?revision=${r}`} />
            </Card>
            <Card title="Notes">
              <Comments caseId={id} revisionId={rev.id} comments={d.comments.map((c) => ({ ...c, revisionNumber: c.revisionId ? revNumber.get(c.revisionId) : null }))} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
