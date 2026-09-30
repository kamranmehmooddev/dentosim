"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, fmtDate, Input, Select, Textarea } from "@/components/ui";
import { Viewer, type ViewerProps } from "@/components/viewer/Viewer";
import { api } from "@/lib/client";
import { Uploader } from "./Uploader";

/** Live processing status; refreshes the page when the revision state changes. */
export function ProcessingStatus({ revisionId, initialStatus }: { revisionId: string; initialStatus: string }) {
  const router = useRouter();
  const [s, setS] = useState<{ revisionStatus: string; job: { progress: number; message: string | null; status: string } | null; failureReason: string | null } | null>(null);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api<NonNullable<typeof s>>(`/api/revisions/${revisionId}/status`);
        if (stop) return;
        setS(r);
        if (r.revisionStatus !== initialStatus) { router.refresh(); return; }
      } catch { /* retry */ }
      if (!stop) setTimeout(poll, 1500);
    };
    void poll();
    return () => { stop = true; };
  }, [revisionId, initialStatus, router]);
  const pct = s?.job?.progress ?? 0;
  return (
    <div className="space-y-2" aria-live="polite" data-testid="processing-status">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{s?.job?.status === "queued" ? "Queued" : "Processing"}</span>
        <span className="tabular text-stone-600">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-stone-200"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
      <p className="text-xs text-stone-500">{s?.job?.message ?? "Waiting for a processing worker…"}</p>
    </div>
  );
}

export function CaseViewer({ revisionId, engine, mode = "full", gumColor }: { revisionId: string; engine: ViewerProps["engine"]; mode?: "full" | "patient"; gumColor?: string }) {
  return (
    <Viewer
      key={revisionId}
      engine={engine}
      mode={mode}
      gumColor={gumColor}
      className="h-[560px] max-h-[75dvh]"
      loadUrls={async () => (await api<{ files: Record<string, string> }>(`/api/revisions/${revisionId}/package`)).files}
    />
  );
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null;
}

export function LabActions({ caseId, revisionId, status, hasDoctor, isAdmin }: { caseId: string; revisionId: string | null; status: string | null; hasDoctor: boolean; isAdmin: boolean }) {
  const a = useAction();
  const router = useRouter();
  const [showUpload, setShowUpload] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {revisionId && (status === "ready_for_review" || status === "changes_requested") && (
          <Button disabled={a.busy || !hasDoctor} title={hasDoctor ? undefined : "Assign a doctor first"} onClick={() => a.run(() => api(`/api/revisions/${revisionId}/send-to-doctor`, { body: {} }))} data-testid="send-to-doctor">
            Send to doctor for approval
          </Button>
        )}
        {revisionId && status === "approved" && (
          <Button disabled={a.busy} onClick={() => a.run(() => api(`/api/revisions/${revisionId}/publish`, { body: {} }))} data-testid="publish">Publish</Button>
        )}
        {revisionId && (status === "failed" || status === "needs_mapping") && (
          <Button variant="secondary" disabled={a.busy} onClick={() => a.run(() => api(`/api/revisions/${revisionId}/retry`, { body: {} }))}>Retry processing</Button>
        )}
        {status !== "processing" && status !== "uploading" && (
          <Button variant="secondary" onClick={() => setShowUpload((v) => !v)} data-testid="upload-revision">{revisionId ? "Upload new revision" : "Upload export"}</Button>
        )}
        {isAdmin && (
          <Button variant="ghost" className="text-red-700" disabled={a.busy} onClick={() => {
            if (confirm("Permanently delete this case, every revision, package and share link? This cannot be undone.")) void a.run(() => api(`/api/cases/${caseId}`, { method: "DELETE" }), () => router.replace("/dashboard"));
          }}>Delete case</Button>
        )}
      </div>
      {showUpload && <div className="rounded-xl bg-stone-50 p-4"><Uploader caseId={caseId} onDone={() => { setShowUpload(false); router.refresh(); }} /></div>}
      <ErrorLine error={a.error} />
    </div>
  );
}

export function AssignDoctor({ caseId, doctors, current }: { caseId: string; doctors: { id: string; name: string }[]; current: string | null }) {
  const a = useAction();
  return (
    <Select aria-label="Assigned doctor" defaultValue={current ?? ""} disabled={a.busy} onChange={(e) => a.run(() => api(`/api/cases/${caseId}`, { method: "PATCH", body: { doctorUserId: e.target.value || null } }))} className="h-8 text-sm">
      <option value="">— no doctor —</option>
      {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </Select>
  );
}

export function DoctorDecision({ revisionId, revisionNumber }: { revisionId: string; revisionNumber: number }) {
  const a = useAction();
  const [changes, setChanges] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-700">Your decision applies to <strong>revision {revisionNumber}</strong> only.</p>
      {changes ? (
        <>
          <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Describe the changes you need (e.g. less proclination of 11/21, add attachments on 13 and 23)…" aria-label="Requested changes" />
          <div className="flex gap-2">
            <Button variant="danger" disabled={a.busy || !note.trim()} onClick={() => a.run(() => api(`/api/revisions/${revisionId}/decision`, { body: { decision: "changes_requested", note } }))} data-testid="submit-changes">Request changes</Button>
            <Button variant="ghost" onClick={() => setChanges(false)}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={a.busy} onClick={() => a.run(() => api(`/api/revisions/${revisionId}/decision`, { body: { decision: "approved" } }))} data-testid="approve">Approve plan</Button>
          <Button variant="secondary" onClick={() => setChanges(true)} data-testid="request-changes">Request changes</Button>
        </div>
      )}
      <ErrorLine error={a.error} />
    </div>
  );
}

export function Comments({ caseId, revisionId, comments }: { caseId: string; revisionId: string | null; comments: { id: string; body: string; authorName: string | null; createdAt: string | Date; revisionNumber?: number | null }[] }) {
  const a = useAction();
  const [text, setText] = useState("");
  return (
    <div className="space-y-3">
      <ul className="space-y-3" data-testid="comments">
        {comments.length === 0 && <li className="text-sm text-stone-500">No notes yet.</li>}
        {comments.map((c) => (
          <li key={c.id} className="rounded-lg bg-stone-50 p-3">
            <div className="mb-1 flex justify-between gap-2 text-xs text-stone-500">
              <span className="font-medium text-stone-700">{c.authorName ?? "Former member"}{c.revisionNumber ? ` · revision ${c.revisionNumber}` : ""}</span>
              <span>{fmtDate(c.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{c.body}</p>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); void a.run(() => api(`/api/cases/${caseId}/comments`, { body: { body: text, revisionId } }), () => setText("")); }} className="space-y-2">
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note…" aria-label="New note" />
        <Button size="sm" disabled={a.busy || !text.trim()}>Add note</Button>
      </form>
      <ErrorLine error={a.error} />
    </div>
  );
}

export interface ShareRow {
  id: string;
  url: string;
  active: boolean;
  hasPin: boolean;
  expiresAt: string | Date | null;
  revokedAt: string | Date | null;
  viewCount: number;
  lastViewedAt: string | Date | null;
  createdAt: string | Date;
}

export function SharePanel({ caseId, revisionId, shares }: { caseId: string; revisionId: string; shares: ShareRow[] }) {
  const a = useAction();
  const [expiry, setExpiry] = useState<"never" | "date">("never");
  const [date, setDate] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (url: string, id: string) => { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(null), 1500); };
  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api<{ url: string }>(`/api/cases/${caseId}/shares`, {
              body: { revisionId, expiresAt: expiry === "date" && date ? new Date(`${date}T23:59:59`).toISOString() : null, pin: pin || null, emailTo: email || null },
            });
            setCreated(r.url);
            setPin("");
          });
        }}
      >
        <label className="text-sm">
          <span className="mb-1 block font-medium text-stone-700">Expiry</span>
          <div className="flex gap-2">
            <Select value={expiry} onChange={(e) => setExpiry(e.target.value as "never" | "date")} className="w-28"><option value="never">Never</option><option value="date">On date</option></Select>
            {expiry === "date" && <Input type="date" required value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />}
          </div>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-stone-700">PIN (optional)</span>
          <Input inputMode="numeric" pattern="\d{4,8}" placeholder="4–8 digits" value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-stone-700">Email the link to the patient (optional)</span>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="patient@example.com" />
        </label>
        <div className="sm:col-span-2"><Button disabled={a.busy} data-testid="create-share">Create patient link</Button></div>
      </form>
      {created && (
        <div className="rounded-lg bg-emerald-50 p-3 text-sm ring-1 ring-emerald-200">
          <p className="mb-1 font-medium text-emerald-900">Link created</p>
          <code className="block break-all text-xs" data-testid="share-url">{created}</code>
        </div>
      )}
      <ErrorLine error={a.error} />
      <ul className="divide-y divide-stone-100 text-sm">
        {shares.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className={s.active ? "text-emerald-700" : "text-stone-400"}>{s.active ? "Active" : s.revokedAt ? "Revoked" : "Expired"}</span>
            <span className="text-stone-500">· {s.hasPin ? "PIN" : "no PIN"} · {s.expiresAt ? `expires ${fmtDate(s.expiresAt)}` : "never expires"} · {s.viewCount} view{s.viewCount === 1 ? "" : "s"}</span>
            <span className="flex-1" />
            {s.active && (
              <>
                <Button size="sm" variant="secondary" onClick={() => copy(s.url, s.id)}>{copied === s.id ? "Copied" : "Copy link"}</Button>
                <a className="inline-flex h-8 items-center rounded-lg px-3 text-sm ring-1 ring-stone-300 hover:bg-stone-50" href={`/api/shares/${s.id}/qr?case=${caseId}`} target="_blank" rel="noreferrer">QR code</a>
                <Button size="sm" variant="ghost" className="text-red-700" onClick={() => a.run(() => api(`/api/shares/${s.id}/revoke`, { body: {} }))}>Revoke</Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
