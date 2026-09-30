import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeTsm2, makeArch, stageModel, processExport, readExportFiles, writeBinaryStl } from "@dentosim/pipeline";
import { Controller, decodeTsm2, hingeFor, openingAngle, PackageClient, Tsm2DecodeError, type Engine } from "../src/index.js";

describe("browser TSM2 decoder", () => {
  it("decodes what the pipeline encodes (ids, FDI, geometry, normals)", async () => {
    const a = makeArch({ jaw: "upper", seed: 1, stages: 1 });
    const s = stageModel(a, 0);
    const parts = s.teeth.map((t) => ({ id: `tooth-${t.fdi}`, kind: "tooth" as const, fdi: t.fdi, mesh: t.mesh }));
    const { bytes } = await encodeTsm2(parts, { jaw: "upper", stage: 0, content: "stage" }, { simplifyErrorMm: 0, minTriangleRatio: 1, measureError: false });
    const d = await decodeTsm2(bytes);
    expect(d.header.jaw).toBe("upper");
    expect(d.parts.map((p) => p.fdi)).toEqual(parts.map((p) => p.fdi));
    expect(d.parts[0].triangles.length).toBe(parts[0].mesh.indices.length);
    const n = d.parts[0].normals;
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
    const bad = bytes.slice();
    bad[bad.length - 1] ^= 1;
    await expect(decodeTsm2(bad)).rejects.toBeInstanceOf(Tsm2DecodeError);
  });
});

async function makePackage() {
  const up = makeArch({ jaw: "upper", seed: 3, stages: 4 });
  const lo = makeArch({ jaw: "lower", seed: 4, stages: 2 });
  const files = [
    ...[0, 1, 2, 3, 4].map((k) => ({ path: `U_${k}.stl`, data: writeBinaryStl(stageModel(up, k).full) })),
    ...[0, 1, 2].map((k) => ({ path: `L_${k}.stl`, data: writeBinaryStl(stageModel(lo, k).full) })),
  ];
  const out = join(mkdtempSync(join(tmpdir(), "vc-")), "pkg");
  const r = await processExport(readExportFiles(files), out);
  if (r.status !== "ready") throw new Error("expected ready");
  const store = new Map<string, Uint8Array>();
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else store.set(relative(out, p), new Uint8Array(readFileSync(p))); } };
  walk(out);
  return store;
}

class FakeEngine implements Engine {
  stages: unknown[] = [];
  views: string[] = [];
  opening = 0;
  onToothTap?: Engine["onToothTap"];
  setStage(slot: 0 | 1, s: Record<string, { header: { stage?: number } } | null>) { this.stages.push({ slot, upper: s.upper?.header.stage ?? null, lower: s.lower?.header.stage ?? null }); }
  setCompare() {}
  setView(v: string) { this.views.push(v); }
  setJawOpening(a: number) { this.opening = a; }
  setAppearance() {}
  setScans() {}
  async screenshot() { return new Blob(); }
  resize() {}
  dispose() {}
}

describe("package client + controller", () => {
  it("loads through signed URLs, refreshes expired ones, clamps the arch that finished early", async () => {
    const store = await makePackage();
    let generation = 0;
    const urls = () => Object.fromEntries([...store.keys()].map((k) => [k, `https://cdn.test/${generation}/${k}`]));
    const fetchImpl = (async (url: string) => {
      const [, gen, ...rest] = new URL(url).pathname.split("/");
      if (Number(gen) !== generation) return new Response(null, { status: 403 });
      const body = store.get(rest.join("/"));
      return body ? new Response(body) : new Response(null, { status: 404 });
    }) as typeof fetch;
    const initial = urls();
    generation = 1; // initial URLs are now "expired"
    const pkg = new PackageClient(initial, { fetchImpl, refreshUrls: async () => urls() });
    const meta = await pkg.load();
    expect(meta.stagesPerJaw).toEqual({ upper: 5, lower: 3 });
    expect(pkg.clampStage("lower", 4)).toBe(2);

    const engine = new FakeEngine();
    const ctl = new Controller(engine, pkg);
    await ctl.init();
    await ctl.showStage(4);
    expect(engine.stages.at(-1)).toEqual({ slot: 0, upper: 4, lower: 2 });
    const keys: string[] = [];
    for (const key of [" ", " "]) { ctl.handleKey({ key, preventDefault: () => keys.push(key) }); }
    expect(keys.length).toBe(2);
    ctl.setView("upper-occlusal");
    expect(ctl.state.showLower).toBe(false);
    await ctl.setCompare("side-by-side");
    expect(engine.stages).toContainEqual({ slot: 1, upper: 0, lower: null });
    ctl.dispose();
  });

  it("hinge: 20 mm opening at the incisors", async () => {
    const store = await makePackage();
    const lower = await decodeTsm2(store.get("lower/stage-00.tsm2")!);
    const h = hingeFor(lower);
    expect(h.point[2]).toBeLessThan(-20);
    const angle = openingAngle(20, h);
    expect(angle * h.radiusMm).toBeCloseTo(20, 6);
    expect(openingAngle(50, h)).toBeCloseTo(angle, 9); // clamped to 20 mm
  });
});
