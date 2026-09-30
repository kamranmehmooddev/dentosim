import Link from "next/link";
import type { RevisionSummary } from "@dentosim/server";
import { Badge, fmtBytes, fmtDate, StatusBadge } from "@/components/ui";

export function FitStats({ summary }: { summary: RevisionSummary }) {
  const r = summary.registration;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" data-testid="fit-stats">
      <dt className="text-stone-500">Bite source</dt>
      <dd>{r.performed ? "Registered to patient scans" : "Planning export (no scans)"}</dd>
      {r.upper && (<><dt className="text-stone-500">Upper fit</dt><dd className="tabular">{r.upper.trimmedMeanMm.toFixed(3)} mm trimmed mean · {r.upper.medianMm.toFixed(3)} mm median</dd></>)}
      {r.lower && (<><dt className="text-stone-500">Lower fit</dt><dd className="tabular">{r.lower.trimmedMeanMm.toFixed(3)} mm trimmed mean · {r.lower.medianMm.toFixed(3)} mm median</dd></>)}
      <dt className="text-stone-500">Stages</dt>
      <dd>{Object.entries(summary.stagesPerJaw).map(([j, n]) => `${j} ${n}`).join(" · ")}</dd>
      <dt className="text-stone-500">Segmentation</dt>
      <dd>{Object.entries(summary.segmentation).map(([j, s]) => `${j}: ${s.unsegmented ? "unsegmented" : `${s.teeth} teeth, ${s.attachments} attachments`}`).join(" · ") || "—"}</dd>
      {summary.normalization && (<><dt className="text-stone-500">Units / bite</dt><dd>{summary.normalization.sourceUnits} · {summary.normalization.interArch}</dd></>)}
      <dt className="text-stone-500">Package</dt>
      <dd className="tabular">{fmtBytes(summary.packageBytes)} ({summary.compression.ratio}× smaller, ±{summary.compression.errorTrimmedMeanMm.toFixed(3)} mm)</dd>
      <dt className="text-stone-500">Import</dt>
      <dd>{summary.adapter.name}@{summary.adapter.version} · {(summary.processingMs / 1000).toFixed(1)} s</dd>
    </dl>
  );
}

export function Warnings({ summary }: { summary: RevisionSummary }) {
  const w = summary.warnings.filter((x) => x.severity !== "info" || !x.code.startsWith("FDI"));
  if (!w.length) return <p className="text-sm text-stone-500">No warnings.</p>;
  return (
    <ul className="space-y-1.5 text-sm" data-testid="warnings">
      {w.map((x, i) => (
        <li key={i} className="flex gap-2">
          <Badge tone={x.severity === "warning" ? "amber" : x.severity === "error" ? "red" : "neutral"}>{x.severity}</Badge>
          <span>{x.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function RevisionHistory({ caseNumber, revisions, approvals, currentId, hrefFor }: {
  caseNumber: number;
  revisions: { id: string; number: number; status: string; createdAt: Date; approvedAt: Date | null }[];
  approvals: { revisionId: string; decision: string; userName: string | null; createdAt: Date }[];
  currentId: string | null;
  hrefFor: (id: string) => string;
}) {
  return (
    <ol className="space-y-2 text-sm" data-testid="revisions">
      <li className="text-xs font-medium uppercase tracking-wide text-stone-500">Case #{caseNumber}</li>
      {revisions.map((r) => {
        const decisions = approvals.filter((a) => a.revisionId === r.id);
        return (
          <li key={r.id} className={`rounded-lg p-2 ${r.id === currentId ? "bg-brand/5 ring-1 ring-brand/30" : ""}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={hrefFor(r.id)} className="font-medium hover:underline">Revision {r.number}</Link>
              <span className="text-stone-500">— uploaded {fmtDate(r.createdAt)}</span>
              <StatusBadge status={r.status} />
            </div>
            {decisions.map((d, i) => (
              <p key={i} className="mt-1 text-xs text-stone-600">{d.decision === "approved" ? "Approved" : "Changes requested"} by {d.userName ?? "—"} · {fmtDate(d.createdAt)}</p>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
