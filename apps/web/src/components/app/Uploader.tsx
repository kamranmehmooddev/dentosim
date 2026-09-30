"use client";

/**
 * Chunked, resumable upload straight to object storage through pre-signed part
 * URLs. Accepts a .zip/.7z/.rar, loose files selected together, or a dropped
 * folder (nested folders kept). Shows MB/s, detects stalls (no progress for
 * 20 s → the part is aborted and retried), and resumes after a reload by
 * re-selecting the same files (already uploaded parts are skipped).
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, fmtBytes } from "@/components/ui";
import { api } from "@/lib/client";

interface PickedFile {
  path: string;
  file: File;
}

interface ServerFile {
  path: string;
  size: number;
  partSize: number;
  partCount: number;
  completedParts: number[];
}

const CONCURRENCY = 4;
const STALL_MS = 20_000;
const MAX_RETRIES = 6;

const fingerprint = (files: PickedFile[]) => files.map((f) => `${f.path}:${f.file.size}:${f.file.lastModified}`).join("|");

async function readEntry(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let batch: FileSystemEntry[];
    do {
      batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    } while (batch.length);
  }
}

function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: { abort?: () => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(xhr.status >= 200 && xhr.status < 300 ? "Storage did not return an ETag (check bucket CORS: ExposeHeaders ETag)" : `Part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new Error("stalled"));
    signal.abort = () => xhr.abort();
    xhr.send(blob);
  });
}

export function Uploader({ caseId, onDone }: { caseId: string; onDone?: (revisionId: string) => void }) {
  const router = useRouter();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [phase, setPhase] = useState<"pick" | "uploading" | "finishing" | "done" | "error">("pick");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cancelled = useRef(false);
  const samples = useRef<{ t: number; bytes: number }[]>([]);
  const total = files.reduce((s, f) => s + f.file.size, 0);

  useEffect(() => () => { cancelled.current = true; }, []);

  const onPick = (list: FileList | null) => {
    if (!list) return;
    setFiles(Array.from(list).map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })));
    setError(null);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const out: PickedFile[] = [];
    const items = Array.from(e.dataTransfer.items);
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.length) for (const en of entries) await readEntry(en, "", out);
    else for (const f of Array.from(e.dataTransfer.files)) out.push({ path: f.name, file: f });
    setFiles(out.filter((f) => !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(f.path)));
    setError(null);
  };

  const start = useCallback(async () => {
    setPhase("uploading");
    setError(null);
    cancelled.current = false;
    const storeKey = `ds_upload_${caseId}`;
    const fp = fingerprint(files);
    let uploadId: string | null = null;
    let serverFiles: ServerFile[];
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) ?? "null") as { uploadId: string; fp: string } | null;
      if (saved?.fp === fp) {
        const r = await api<{ uploadId: string; status: string; files: ServerFile[] }>(`/api/uploads/${saved.uploadId}`).catch(() => null);
        if (r?.status === "pending") { uploadId = r.uploadId; serverFiles = r.files; }
      }
      if (!uploadId) {
        const r = await api<{ uploadId: string; files: ServerFile[] }>(`/api/cases/${caseId}/uploads`, { body: { files: files.map((f) => ({ path: f.path, size: f.file.size })) } });
        uploadId = r.uploadId;
        serverFiles = r.files;
        localStorage.setItem(storeKey, JSON.stringify({ uploadId, fp }));
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
      return;
    }
    // work queue of parts still missing
    const queue: { fi: number; part: number }[] = [];
    let already = 0;
    serverFiles!.forEach((sf, fi) => {
      for (let p = 1; p <= sf.partCount; p++) {
        if (sf.completedParts.includes(p)) already += Math.min(sf.partSize, sf.size - (p - 1) * sf.partSize);
        else queue.push({ fi, part: p });
      }
    });
    let doneBytes = already;
    const inflight = new Map<string, number>();
    const report = () => {
      const now = performance.now();
      const bytes = doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0);
      setSent(bytes);
      samples.current.push({ t: now, bytes });
      samples.current = samples.current.filter((s) => now - s.t < 5000);
      const first = samples.current[0];
      if (first && now - first.t > 500) setSpeed(((bytes - first.bytes) / (now - first.t)) * 1000);
    };
    report();
    const urlCache = new Map<string, string>();
    const urlFor = async (fi: number, part: number) => {
      const k = `${fi}:${part}`;
      if (!urlCache.has(k)) {
        const batch = queue.filter((q) => q.fi === fi).map((q) => q.part).filter((p) => p >= part).slice(0, 20);
        const { urls } = await api<{ urls: { partNumber: number; url: string }[] }>(`/api/uploads/${uploadId}/parts`, { body: { fileIndex: fi, partNumbers: batch.length ? batch : [part] } });
        for (const u of urls) urlCache.set(`${fi}:${u.partNumber}`, u.url);
      }
      return urlCache.get(k)!;
    };
    const worker = async () => {
      while (queue.length && !cancelled.current) {
        const job = queue.shift()!;
        const sf = serverFiles![job.fi];
        const blob = files[job.fi].file.slice((job.part - 1) * sf.partSize, Math.min(sf.size, job.part * sf.partSize));
        const key = `${job.fi}:${job.part}`;
        for (let attempt = 0; ; attempt++) {
          const signal: { abort?: () => void } = {};
          let last = performance.now();
          const watchdog = setInterval(() => {
            if (performance.now() - last > STALL_MS) { setStalled(true); signal.abort?.(); }
          }, 2000);
          try {
            const url = await urlFor(job.fi, job.part);
            const etag = await putPart(url, blob, (loaded) => { last = performance.now(); setStalled(false); inflight.set(key, loaded); report(); }, signal);
            await api(`/api/uploads/${uploadId}/part-done`, { body: { fileIndex: job.fi, partNumber: job.part, etag } });
            inflight.delete(key);
            doneBytes += blob.size;
            report();
            break;
          } catch (e) {
            inflight.delete(key);
            urlCache.delete(key); // URL may have expired
            if (attempt >= MAX_RETRIES || cancelled.current) throw e;
            await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** attempt)));
          } finally {
            clearInterval(watchdog);
          }
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (cancelled.current) return;
      setPhase("finishing");
      const r = await api<{ revisionId: string }>(`/api/uploads/${uploadId}/complete`, { body: {} });
      localStorage.removeItem(storeKey);
      setPhase("done");
      if (onDone) onDone(r.revisionId);
      else router.push(`/cases/${caseId}`);
      router.refresh();
    } catch (e) {
      setError(`${(e as Error).message}. Select the same files again to resume where it stopped.`);
      setPhase("error");
    }
  }, [caseId, files, onDone, router]);

  const pct = total ? Math.min(100, (sent / total) * 100) : 0;
  const eta = speed > 0 ? Math.max(0, (total - sent) / speed) : 0;

  return (
    <div className="space-y-4" data-testid="uploader">
      {phase === "pick" || phase === "error" ? (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition ${dragging ? "border-brand bg-brand/5" : "border-stone-300"}`}
          >
            <p className="font-medium text-stone-800">Drop the planning-software export here</p>
            <p className="mt-1 text-sm text-stone-500">A .zip (or .7z/.rar), a whole folder, or all model files at once — STL, OBJ, PLY, 3MF, glTF. Up to 2 GB.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <label className="cursor-pointer rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-stone-300 hover:bg-stone-50">
                Choose files
                <input type="file" multiple className="sr-only" data-testid="file-input" onChange={(e) => onPick(e.target.files)} />
              </label>
              <label className="cursor-pointer rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-stone-300 hover:bg-stone-50">
                Choose folder
                <input type="file" className="sr-only" {...({ webkitdirectory: "", directory: "" } as object)} onChange={(e) => onPick(e.target.files)} />
              </label>
            </div>
          </div>
          {files.length > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-stone-50 px-4 py-3 text-sm">
              <span>{files.length} file{files.length === 1 ? "" : "s"} · {fmtBytes(total)}</span>
              <Button onClick={start} data-testid="start-upload">Upload</Button>
            </div>
          )}
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </>
      ) : (
        <div className="space-y-2" aria-live="polite">
          <div className="flex justify-between text-sm">
            <span className="font-medium">{phase === "finishing" ? "Finishing…" : phase === "done" ? "Uploaded" : stalled ? "Connection stalled — retrying…" : "Uploading…"}</span>
            <span className="tabular text-stone-600">{fmtBytes(sent)} / {fmtBytes(total)} · {(speed / 1e6).toFixed(1)} MB/s{eta > 1 ? ` · ${Math.ceil(eta)} s left` : ""}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-stone-200">
            <div className={`h-full transition-all ${stalled ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${pct}%` }} />
          </div>
          {phase === "uploading" && <Button variant="ghost" size="sm" onClick={() => { cancelled.current = true; setPhase("pick"); }}>Pause</Button>}
        </div>
      )}
    </div>
  );
}
