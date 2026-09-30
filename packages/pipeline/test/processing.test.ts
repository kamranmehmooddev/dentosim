import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateCanonicalManifest, type CanonicalCase } from "@dentosim/canonical";
import { ImportContext } from "../src/adapters/context.js";
import { runImport } from "../src/adapters/registry.js";
import { makeArch, scanOf, stageModel } from "../src/fixtures/synth.js";
import { writeBinaryStl } from "../src/io/loaders.js";
import { readExportFiles } from "../src/io/input.js";
import { det3of4, multiply4, rigidFromEuler, rotationAngleDeg, transformPoint, type Mat4 } from "../src/math/linalg.js";
import { mergeMeshes, surfaceCentroid, transformMesh } from "../src/mesh/mesh.js";
import { archWidth, detectUnits } from "../src/normalize/units.js";
import { guessJawFromGeometry } from "../src/normalize/archframe.js";
import { segmentModel } from "../src/process/segment.js";
import { registerMeshes } from "../src/process/register.js";
import { decodeTsm2, encodeTsm2, readTsm2Header, Tsm2Error } from "../src/tsm2/tsm2.js";
import { processExport } from "../src/pipeline.js";

const deg = (d: number) => (d * Math.PI) / 180;
const work = mkdtempSync(join(tmpdir(), "dentosim-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const upper = makeArch({ jaw: "upper", seed: 11, stages: 4, attachments: true, embossedText: true });
const lower = makeArch({ jaw: "lower", seed: 12, stages: 4, attachments: true, embossedText: true });

describe("units", () => {
  it.each([
    [1, "mm"], [1 / 25.4, "inch"], [1 / 10, "cm"], [1 / 1000, "m"],
  ])("scale %f is detected as %s", (s, units) => {
    const w = archWidth(stageModel(upper, 0).full) * s;
    expect(detectUnits(w).units).toBe(units);
  });
});

describe("jaw from geometry", () => {
  it("recognises the palate of an upper model", () => {
    expect(guessJawFromGeometry(stageModel(upper, 0).full).jaw).toBe("upper");
    expect(guessJawFromGeometry(stageModel(lower, 0).full).jaw).toBe("lower");
  });
});

describe("segmentation", () => {
  it("separates gums, 14 teeth, attachments and drops embossed text", () => {
    const s = segmentModel(stageModel(upper, 2).full);
    expect(s.gums).toBeDefined();
    expect(s.teeth).toHaveLength(14);
    expect(s.attachments).toHaveLength(6);
    expect(s.dropped).toBe(5);
    expect(s.unsegmented).toBe(false);
  });

  it("splits a fused last molar at its waist", () => {
    const a = makeArch({ jaw: "lower", seed: 3, stages: 0, fusedMolar: true });
    const s = segmentModel(stageModel(a, 0).full);
    expect(s.fusedSplit).toBe(1);
    expect(s.teeth).toHaveLength(14);
  });

  it("flags a single-shell arch as unsegmented", () => {
    const a = makeArch({ jaw: "lower", seed: 4, stages: 0, singleShell: true });
    expect(segmentModel(stageModel(a, 0).full).unsegmented).toBe(true);
  });
});

describe("registration", () => {
  const teeth = mergeMeshes(stageModel(upper, 0).teeth.map((t) => t.mesh));
  const scan = scanOf(upper, 5);

  it("recovers a large rigid transform with sub-0.1 mm fit", () => {
    const T = rigidFromEuler(deg(70), deg(-20), deg(160), [12, -30, 44]);
    const fit = registerMeshes(teeth, transformMesh(scan, T));
    expect(fit.trimmedMeanMm).toBeLessThan(0.1);
    // the recovered transform equals T (the scan is the stage-0 geometry moved by T)
    const residual = multiply4(fit.matrix, invert(T));
    expect(rotationAngleDeg(residual)).toBeLessThan(0.2);
    const p = transformPoint(fit.matrix, surfaceCentroid(teeth)), q = transformPoint(T, surfaceCentroid(teeth));
    expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(0.1);
  });

  it("is rigid only: never mirrors or scales, even against a mirrored scan", () => {
    const mirrored = { positions: scan.positions.map((v, i) => (i % 3 === 0 ? -v : v)), indices: scan.indices };
    const fit = registerMeshes(teeth, mirrored);
    expect(det3of4(fit.matrix)).toBeCloseTo(1, 6);
    const col = (k: number) => Math.hypot(fit.matrix[k * 4], fit.matrix[k * 4 + 1], fit.matrix[k * 4 + 2]);
    expect(col(0)).toBeCloseTo(1, 6);
    expect(col(1)).toBeCloseTo(1, 6);
    expect(col(2)).toBeCloseTo(1, 6);
  });
});

function invert(m: Mat4): Mat4 {
  // rigid inverse
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
  r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
  r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
  return r;
}

describe("TSM2", () => {
  const s = stageModel(upper, 1);
  const parts = [
    { id: "gums", kind: "gums" as const, mesh: s.gums },
    ...s.teeth.map((t) => ({ id: `tooth-${t.fdi}`, kind: "tooth" as const, fdi: t.fdi, mesh: t.mesh })),
  ];

  it("round-trips with sub-0.15 mm error and ≥5× smaller than binary STL", async () => {
    const { bytes, stats } = await encodeTsm2(parts, { jaw: "upper", stage: 1, content: "stage" });
    const stl = writeBinaryStl(mergeMeshes(parts.map((p) => p.mesh)));
    expect(stl.length / bytes.length).toBeGreaterThanOrEqual(5);
    for (const st of stats) expect(st.errorTrimmedMeanMm!).toBeLessThan(0.15);
    const d = await decodeTsm2(bytes);
    expect(d.header).toMatchObject({ format: "TSM2", version: 1, jaw: "upper", stage: 1, units: "mm" });
    expect(d.parts.map((p) => p.id)).toEqual(parts.map((p) => p.id));
    expect(d.parts[1].fdi).toBe(parts[1].fdi);
  });

  it("detects corruption and truncation", async () => {
    const { bytes } = await encodeTsm2(parts.slice(0, 2), { content: "stage" });
    const bad = bytes.slice();
    bad[bad.length - 5] ^= 0xff;
    expect(readTsm2Header(bad).crcOk).toBe(false);
    await expect(decodeTsm2(bad)).rejects.toThrow(/checksum/);
    expect(() => readTsm2Header(bytes.slice(0, bytes.length - 3))).toThrow(Tsm2Error);
    expect(() => readTsm2Header(new Uint8Array(40))).toThrow(/not a TSM2/);
  });
});

describe("end-to-end", () => {
  const files = (T: Mat4, lowerT: Mat4 = T) => [
    ...[0, 1, 2, 3, 4].map((k) => ({ path: `U/upper_${k}.stl`, data: writeBinaryStl(transformMesh(stageModel(upper, k).full, T)) })),
    ...[0, 1, 2, 3, 4].map((k) => ({ path: `L/lower_${k}.stl`, data: writeBinaryStl(transformMesh(stageModel(lower, k).full, lowerT)) })),
  ];

  it("normalises a tilted, rotated export into the DentoSim frame", async () => {
    const T = rigidFromEuler(deg(35), deg(120), deg(-20), [10, 20, 30]);
    const r = await processExport(readExportFiles(files(T)), join(work, "tilted"));
    if (r.status !== "ready") throw new Error(r.reasons.join("; "));
    const c = r.case;
    const cent = (jaw: "upper" | "lower", pick: (fdi: number) => boolean) =>
      surfaceCentroid(mergeMeshes(c.arches[jaw]!.stages[0].parts.filter((p) => p.kind === "tooth" && pick(p.fdi!)).map((p) => p.mesh)));
    expect(cent("upper", () => true)[1]).toBeGreaterThan(cent("lower", () => true)[1]);
    expect(cent("upper", (f) => f % 10 === 1)[2]).toBeGreaterThan(cent("upper", (f) => f % 10 === 7)[2]);
    expect(cent("upper", (f) => f < 20)[0]).toBeLessThan(0); // quadrant 1 = patient right = −X
    // orientation is recovered to within a few degrees of the synthetic truth frame
    const truth = surfaceCentroid(stageModel(upper, 0).teeth.find((t) => t.fdi === 17)!.mesh);
    const truth2 = surfaceCentroid(stageModel(upper, 0).teeth.find((t) => t.fdi === 27)!.mesh);
    const got = cent("upper", (f) => f === 17), got2 = cent("upper", (f) => f === 27);
    const a = [truth2[0] - truth[0], truth2[1] - truth[1], truth2[2] - truth[2]], b = [got2[0] - got[0], got2[1] - got[1], got2[2] - got[2]];
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
    expect((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toBeLessThan(5);
    expect(c.normalization?.interArch).toBe("export");
  });

  it("without scans keeps the export's (wrong) bite; with scans restores the true bite", async () => {
    const wrong = multiply4(rigidFromEuler(deg(3), 0, deg(2), [1.5, -1.2, 2]), rigidFromEuler(0, 0, 0));
    const dist = (c: CanonicalCase) => {
      const a = surfaceCentroid(c.arches.upper!.stages[0].parts.find((p) => p.fdi === 11)!.mesh);
      const b = surfaceCentroid(c.arches.lower!.stages[0].parts.find((p) => p.fdi === 41)!.mesh);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    const truth = (() => {
      const a = surfaceCentroid(stageModel(upper, 0).teeth.find((t) => t.fdi === 11)!.mesh), b = surfaceCentroid(stageModel(lower, 0).teeth.find((t) => t.fdi === 41)!.mesh);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    })();
    const I = rigidFromEuler(0, 0, 0);
    const noScans = await processExport(readExportFiles(files(I, wrong)), join(work, "noscan"));
    if (noScans.status !== "ready") throw new Error("expected ready");
    expect(noScans.case.registration?.performed).toBe(false);
    expect(Math.abs(dist(noScans.case) - truth)).toBeGreaterThan(0.5);

    const scanT = rigidFromEuler(deg(-60), deg(10), deg(100), [5, 5, 5]);
    const withScans = await processExport(
      readExportFiles([
        ...files(I, wrong),
        { path: "scans/upper scan.ply", data: writeBinaryStl(transformMesh(scanOf(upper, 1), scanT)) },
        { path: "scans/lower scan.stl", data: writeBinaryStl(transformMesh(scanOf(lower, 2), scanT)) },
      ].map((f) => (f.path.endsWith(".ply") ? { ...f, path: f.path.replace(".ply", ".stl") } : f))),
      join(work, "scans"),
    );
    if (withScans.status !== "ready") throw new Error(withScans.reasons.join("; "));
    expect(withScans.case.registration?.performed).toBe(true);
    expect(withScans.case.registration!.upper!.trimmedMeanMm).toBeLessThan(0.1);
    expect(Math.abs(dist(withScans.case) - truth)).toBeLessThan(0.1);
  });

  it("writes an immutable, schema-valid package with hashes", async () => {
    const out = join(work, "pkg");
    const r = await processExport(readExportFiles(files(rigidFromEuler(0, 0, 0))), out);
    if (r.status !== "ready") throw new Error("expected ready");
    const meta = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8"));
    expect(validateCanonicalManifest(meta.case)).toEqual({ valid: true, errors: [] });
    expect(Object.keys(meta.files)).toContain("upper/stage-04.tsm2");
    expect(meta.disclaimer.length).toBe(3);
    await expect(processExport(readExportFiles(files(rigidFromEuler(0, 0, 0))), out)).rejects.toThrow(/immutable/);
  });

  it("accepts an upper-only / lower-only export", async () => {
    const ctx = new ImportContext(readExportFiles([0, 1].map((k) => ({ path: `lower_${k}.stl`, data: writeBinaryStl(stageModel(lower, k).full) }))).files);
    const r = runImport(ctx);
    expect(r.result.kind).toBe("case");
  });
});
