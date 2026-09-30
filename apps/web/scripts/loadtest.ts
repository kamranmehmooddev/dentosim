/**
 * Load test (Phase 8): N concurrent large uploads through the real HTTP API
 * (pre-signed multipart parts, 4 parallel parts per upload), then waits until
 * every case is processed by the worker(s).
 *
 *   pnpm --filter @dentosim/web loadtest -- --uploads 10 --stages 20
 *   env: E2E_BASE_URL (default http://localhost:3000), LOADTEST_EMAIL, SEED_PASSWORD
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { makeArch, stageModel, writeBinaryStl } from "@dentosim/pipeline";

const { values } = parseArgs({ options: { uploads: { type: "string" }, stages: { type: "string" }, lat: { type: "string" } } });
const N = +(values.uploads ?? 10), STAGES = +(values.stages ?? 20), LAT = +(values.lat ?? 56);
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.LOADTEST_EMAIL ?? "tech@demo.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "dentosim-demo-2026";

function generate(): { path: string; data: Buffer }[] {
  const dir = join(tmpdir(), `dentosim-load-${STAGES}-${LAT}`);
  try {
    if (readdirSync(dir).length) return walk(dir);
  } catch { /* generate */ }
  mkdirSync(dir, { recursive: true });
  for (const jaw of ["upper", "lower"] as const) {
    const a = makeArch({ jaw, seed: jaw === "upper" ? 1 : 2, stages: STAGES, attachments: true, embossedText: true, lat: LAT, lon: Math.round(LAT * 1.6) });
    for (let k = 0; k <= STAGES; k++) writeFileSync(join(dir, `${jaw === "upper" ? "Maxillary" : "Mandibular"}_Stage_${String(k).padStart(2, "0")}.stl`), writeBinaryStl(stageModel(a, k).full));
  }
  return walk(dir);
  function walk(d: string) {
    return readdirSync(d).filter((f) => statSync(join(d, f)).isFile()).map((f) => ({ path: relative(d, join(d, f)), data: readFileSync(join(d, f)) }));
  }
}

async function main() {
  const files = generate();
  const total = files.reduce((s, f) => s + f.data.length, 0);
  console.log(`export: ${files.length} files, ${(total / 1e6).toFixed(1)} MB; ${N} concurrent uploads → ${((total * N) / 1e9).toFixed(2)} GB`);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "Content-Type": "application/json", Origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${j.error}`);
    return j as T;
  };

  const one = async (i: number) => {
    const c = await api<{ id: string }>("/api/cases", { patientReference: `LOAD-${Date.now().toString(36)}-${i}` });
    const t0 = Date.now();
    const up = await api<{ uploadId: string; files: { partSize: number; partCount: number }[] }>(`/api/cases/${c.id}/uploads`, { files: files.map((f) => ({ path: f.path, size: f.data.length })) });
    const queue = up.files.flatMap((f, fi) => Array.from({ length: f.partCount }, (_, k) => ({ fi, part: k + 1 })));
    const worker = async () => {
      while (queue.length) {
        const { fi, part } = queue.shift()!;
        const { urls } = await api<{ urls: { url: string }[] }>(`/api/uploads/${up.uploadId}/parts`, { fileIndex: fi, partNumbers: [part] });
        const size = up.files[fi].partSize;
        const res = await fetch(urls[0].url, { method: "PUT", body: new Uint8Array(files[fi].data.subarray((part - 1) * size, part * size)) });
        if (!res.ok) throw new Error(`part ${part}: ${res.status}`);
        await api(`/api/uploads/${up.uploadId}/part-done`, { fileIndex: fi, partNumber: part, etag: res.headers.get("etag") });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const { revisionId } = await api<{ revisionId: string }>(`/api/uploads/${up.uploadId}/complete`, {});
    const uploadS = (Date.now() - t0) / 1000;
    for (;;) {
      const s = await api<{ revisionStatus: string; failureReason: string | null }>(`/api/revisions/${revisionId}/status`);
      if (s.revisionStatus === "ready_for_review") break;
      if (s.revisionStatus === "failed" || s.revisionStatus === "needs_mapping") throw new Error(`case ${i}: ${s.revisionStatus} ${s.failureReason ?? ""}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { i, uploadS, readyS: (Date.now() - t0) / 1000 };
  };

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
  const wall = (Date.now() - t0) / 1000;
  for (const r of results.sort((a, b) => a.i - b.i)) console.log(`  upload ${r.i}: uploaded in ${r.uploadS.toFixed(1)} s (${((total / 1e6) / r.uploadS).toFixed(1)} MB/s), ready after ${r.readyS.toFixed(1)} s`);
  console.log(`all ${N} ready in ${wall.toFixed(1)} s; aggregate upload throughput ${((total * N) / 1e6 / Math.max(...results.map((r) => r.uploadS))).toFixed(0)} MB/s`);
  if (process.env.LOADTEST_CLEANUP) rmSync(join(tmpdir(), `dentosim-load-${STAGES}-${LAT}`), { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
