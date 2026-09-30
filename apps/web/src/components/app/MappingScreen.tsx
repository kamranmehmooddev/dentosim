"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { api } from "@/lib/client";

interface Entry {
  path: string;
  node?: string;
  role: string;
  jaw?: string;
  stageLabel?: string;
  fdi?: number;
  partKind?: string;
  confidence?: number;
  reason?: string;
  thumbnailKey?: string;
}

/** One dropdown value encodes role + jaw (+ stage chosen separately). */
const CHOICES = [
  { v: "upper-stage", label: "Upper · stage" },
  { v: "lower-stage", label: "Lower · stage" },
  { v: "scan-upper", label: "Upper scan" },
  { v: "scan-lower", label: "Lower scan" },
  { v: "scan-bite", label: "Bite scan" },
  { v: "retainer", label: "Retainer" },
  { v: "attachment-template", label: "Attachment template" },
  { v: "ignore", label: "Ignore" },
];

const choiceOf = (e: Entry) => (e.role === "stage" || e.role === "tooth" ? `${e.jaw ?? "upper"}-stage` : ["scan-upper", "scan-lower", "scan-bite", "retainer", "attachment-template"].includes(e.role) ? e.role : "ignore");
const key = (e: Entry) => (e.node !== undefined ? `${e.path}#${e.node}` : e.path);

export function MappingScreen({ caseId, revisionId, entries: initial }: { caseId: string; revisionId: string; entries: Entry[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(() => initial.map((e) => ({ ...e, choice: choiceOf(e), stage: e.stageLabel ?? "" })));
  const [software, setSoftware] = useState("");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const problems = useMemo(() => rows.filter((r) => r.choice.endsWith("-stage") && !/^(\d{1,3}|initial|final)$/.test(r.stage)).length, [rows]);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  /** drag a row onto another to swap their assignments (reorder stages quickly) */
  const swap = (a: number, b: number) =>
    setRows((rs) => {
      const next = [...rs];
      const A = { choice: next[a].choice, stage: next[a].stage }, B = { choice: next[b].choice, stage: next[b].stage };
      next[a] = { ...next[a], ...B };
      next[b] = { ...next[b], ...A };
      return next;
    });

  /** renumber the stages of one arch 0…N in the current row order */
  const renumber = (jaw: "upper" | "lower") => {
    let n = 0;
    setRows((rs) => rs.map((r) => (r.choice === `${jaw}-stage` ? { ...r, stage: String(n++) } : r)));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/revisions/${revisionId}/mapping`, {
        body: {
          saveTemplate: save,
          software: software || undefined,
          templateName: software ? `${software} export` : undefined,
          entries: rows.map((r) => {
            const base = { path: r.path, ...(r.node !== undefined ? { node: r.node } : {}) };
            if (r.choice.endsWith("-stage"))
              return { ...base, role: r.role === "tooth" ? "tooth" : "stage", jaw: r.choice.startsWith("upper") ? "upper" : "lower", stageLabel: r.stage, ...(r.fdi ? { fdi: r.fdi } : {}), ...(r.partKind ? { partKind: r.partKind } : {}) };
            return { ...base, role: r.choice };
          }),
        },
      });
      router.push(`/cases/${caseId}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-sm">
        <Button size="sm" variant="secondary" onClick={() => renumber("upper")}>Number upper stages 0…N in list order</Button>
        <Button size="sm" variant="secondary" onClick={() => renumber("lower")}>Number lower stages 0…N in list order</Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="mapping-rows">
        {rows.map((r, i) => (
          <li
            key={key(r)}
            draggable
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag !== null && drag !== i) swap(drag, i); setDrag(null); }}
            className={`flex gap-3 rounded-xl bg-white p-3 ring-1 ${r.confidence !== undefined && r.confidence < 0.7 ? "ring-amber-300" : "ring-stone-200"}`}
          >
            <div className="h-[90px] w-[120px] shrink-0 overflow-hidden rounded-lg bg-stone-100">
              {r.thumbnailKey ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/revisions/${revisionId}/thumb?key=${encodeURIComponent(r.thumbnailKey)}`} alt="" className="h-full w-full object-contain" loading="lazy" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-stone-400">no preview</div>
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="truncate text-xs font-medium text-stone-800" title={key(r)}>{r.node !== undefined ? `${r.path} › ${r.node}` : r.path}</p>
              <select aria-label={`Role of ${key(r)}`} className="h-8 w-full rounded-md bg-stone-50 px-2 text-sm ring-1 ring-stone-300" value={r.choice} onChange={(e) => set(i, { choice: e.target.value })} data-testid="mapping-role">
                {CHOICES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
              </select>
              {r.choice.endsWith("-stage") && (
                <div className="flex items-center gap-2">
                  <input aria-label={`Stage of ${key(r)}`} className="h-8 w-24 rounded-md px-2 text-sm ring-1 ring-stone-300" placeholder="0, 1… / initial" value={r.stage} onChange={(e) => set(i, { stage: e.target.value.trim().toLowerCase() })} data-testid="mapping-stage" />
                  {r.fdi && <span className="text-xs text-stone-500">tooth {r.fdi}</span>}
                </div>
              )}
              {r.reason && <p className="truncate text-[11px] text-stone-400" title={r.reason}>{r.reason}</p>}
            </div>
          </li>
        ))}
      </ul>
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-end gap-4 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
        <Field label="Planning software (for the template)"><Input value={software} onChange={(e) => setSoftware(e.target.value)} placeholder="e.g. Archform" className="w-56" /></Field>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />Remember for next time</label>
        <span className="flex-1" />
        {problems > 0 && <span className="text-sm text-amber-700">{problems} stage file(s) need a stage number</span>}
        <Button onClick={submit} disabled={busy || problems > 0} data-testid="confirm-mapping">{busy ? "Saving…" : "Confirm mapping & process"}</Button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
