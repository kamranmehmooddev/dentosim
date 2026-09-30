/**
 * Immutable simulation package — the only thing the viewer ever reads.
 *
 *   <package>/
 *   ├── metadata.json        manifest: Canonical Case (mesh refs), stats, file hashes
 *   ├── registration.json    bite registration report
 *   ├── upper/stage-00.tsm2 …
 *   ├── lower/stage-00.tsm2 …
 *   ├── scans/upper.tsm2 …   (when patient scans were supplied)
 *   └── thumbnails/*.png
 *
 * Written into a temporary sibling directory and renamed into place, so a
 * package is either complete or absent. Every file's SHA-256 is recorded in
 * metadata.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertCanonicalManifest,
  caseStageCount,
  type CanonicalCase,
  type Jaw,
  type MeshRef,
  type Part,
  type Stage,
} from "@dentosim/canonical";
import { mergeMeshes, type Mesh } from "../mesh/mesh.js";
import { COLORS, renderPng, type RenderItem, type View } from "../render/raster.js";
import { DEFAULT_COMPRESS, encodeTsm2, type CompressOptions, type PartStats } from "../tsm2/tsm2.js";

export const PACKAGE_FORMAT = "dentosim-package/1";
export const PIPELINE_VERSION = "0.1.0";

export const DISCLAIMER = [
  "Stages are shown exactly as exported by the planning software; no movement is interpolated between stages.",
  "Gums may be illustrative and do not necessarily reflect the patient's soft tissue.",
  "Jaw opening is a simulated hinge movement, not recorded patient motion.",
];

export interface PackageMetadata {
  packageFormat: typeof PACKAGE_FORMAT;
  createdAt: string;
  generator: { name: string; version: string };
  stageCount: number;
  stagesPerJaw: Partial<Record<Jaw, number>>;
  case: CanonicalCase<MeshRef>;
  compression: {
    sourceBytes: number;
    meshBytes: number;
    ratio: number;
    errorTrimmedMeanMm: number;
    errorMaxMm: number;
    triangles: number;
    sourceTriangles: number;
  };
  thumbnails: string[];
  disclaimer: string[];
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface PackageOptions {
  compress?: CompressOptions;
  thumbnails?: boolean;
  /** replace an existing package directory (CLI only; the service never overwrites) */
  overwrite?: boolean;
  createdAt?: string;
  onProgress?: (fraction: number, message: string) => void;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export const stagePath = (jaw: Jaw, index: number) => `${jaw}/stage-${pad2(index)}.tsm2`;

function colorOf(p: Part) {
  return COLORS[p.kind];
}

function stageItems(stage: Stage | undefined): RenderItem[] {
  return stage ? stage.parts.filter((p) => p.kind !== "base").map((p) => ({ mesh: p.mesh, color: colorOf(p) })) : [];
}

export async function writePackage(c: CanonicalCase, outDir: string, opts: PackageOptions = {}): Promise<PackageMetadata> {
  const compress = opts.compress ?? DEFAULT_COMPRESS;
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    if (!opts.overwrite) throw new Error(`Package directory already exists and is not empty: ${outDir} (packages are immutable)`);
  }
  const tmp = `${outDir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  const files: PackageMetadata["files"] = {};
  const write = (rel: string, data: Uint8Array | string) => {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    writeFileSync(abs, bytes);
    if (rel !== "metadata.json") files[rel] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  };
  try {
    const allStats: PartStats[] = [];
    let meshBytes = 0;
    const jaws = (["upper", "lower"] as Jaw[]).filter((j) => c.arches[j]);
    const totalStages = jaws.reduce((s, j) => s + c.arches[j]!.stages.length, 0);
    let done = 0;
    const manifestArches: CanonicalCase<MeshRef>["arches"] = {};
    for (const jaw of jaws) {
      const arch = c.arches[jaw]!;
      const stages: Stage<MeshRef>[] = [];
      for (const st of arch.stages) {
        const rel = stagePath(jaw, st.index);
        const { bytes, header, stats } = await encodeTsm2(st.parts, { jaw, stage: st.index, content: "stage" }, compress);
        write(rel, bytes);
        meshBytes += bytes.length;
        allStats.push(...stats);
        stages.push({
          index: st.index,
          ...(st.sourceLabel !== undefined ? { sourceLabel: st.sourceLabel } : {}),
          sourceFiles: st.sourceFiles,
          segmented: st.segmented,
          parts: st.parts.map((p, i) => ({
            id: p.id,
            kind: p.kind,
            ...(p.fdi !== undefined ? { fdi: p.fdi } : {}),
            ...(p.fdiEstimated ? { fdiEstimated: true } : {}),
            ...(p.procedural ? { procedural: true } : {}),
            mesh: { uri: `${rel}#${p.id}`, vertexCount: header.parts[i].vertexCount, triangleCount: header.parts[i].triangleCount },
          })),
        });
        opts.onProgress?.(++done / totalStages, `Compressed ${jaw} stage ${st.index}`);
      }
      manifestArches[jaw] = { jaw, stages };
    }
    let manifestScans: CanonicalCase<MeshRef>["scans"];
    if (c.scans) {
      manifestScans = {};
      for (const k of ["upper", "lower", "bite"] as const) {
        const m = c.scans[k];
        if (!m) continue;
        const rel = `scans/${k}.tsm2`;
        const { bytes, header } = await encodeTsm2([{ id: `scan-${k}`, kind: "arch", mesh: m }], { ...(k !== "bite" ? { jaw: k } : {}), content: "scan" }, { ...compress, measureError: false });
        write(rel, bytes);
        manifestScans[k] = { uri: rel, vertexCount: header.parts[0].vertexCount, triangleCount: header.parts[0].triangleCount };
      }
    }

    const thumbnails: string[] = [];
    if (opts.thumbnails !== false) {
      const last = (j: Jaw) => c.arches[j]!.stages[c.arches[j]!.stages.length - 1];
      const shots: [string, RenderItem[], View][] = [
        ["thumbnails/initial-front.png", jaws.flatMap((j) => stageItems(c.arches[j]!.stages[0])), "front"],
        ["thumbnails/final-front.png", jaws.flatMap((j) => stageItems(last(j))), "front"],
      ];
      if (c.arches.upper) shots.push(["thumbnails/upper-occlusal-final.png", stageItems(last("upper")), "bottom"]);
      if (c.arches.lower) shots.push(["thumbnails/lower-occlusal-final.png", stageItems(last("lower")), "top"]);
      for (const [rel, items, view] of shots) {
        write(rel, renderPng(items, { width: 480, height: 320, view, background: [247, 247, 245, 255] }));
        thumbnails.push(rel);
      }
    }

    const { scans: _s, arches: _a, ...rest } = c;
    const manifest: CanonicalCase<MeshRef> = { ...rest, arches: manifestArches, ...(manifestScans ? { scans: manifestScans } : {}) };
    assertCanonicalManifest(JSON.parse(JSON.stringify(manifest)));

    const sourceBytes = c.source.fileMap
      .filter((f) => f.role === "stage" || f.role === "tooth")
      .reduce((s, f, i, arr) => (arr.findIndex((g) => g.path === f.path) === i ? s + (f.sizeBytes ?? 0) : s), 0);
    const stageMeshBytes = Object.entries(files).filter(([k]) => /^(upper|lower)\//.test(k)).reduce((s, [, v]) => s + v.bytes, 0);
    const errs = allStats.filter((s) => s.errorTrimmedMeanMm !== undefined);
    const metadata: PackageMetadata = {
      packageFormat: PACKAGE_FORMAT,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      generator: { name: "@dentosim/pipeline", version: PIPELINE_VERSION },
      stageCount: caseStageCount(c),
      stagesPerJaw: Object.fromEntries(jaws.map((j) => [j, c.arches[j]!.stages.length])),
      case: manifest,
      compression: {
        sourceBytes,
        meshBytes: stageMeshBytes,
        ratio: stageMeshBytes ? +(sourceBytes / stageMeshBytes).toFixed(2) : 0,
        errorTrimmedMeanMm: errs.length ? +Math.max(...errs.map((s) => s.errorTrimmedMeanMm!)).toFixed(5) : 0,
        errorMaxMm: errs.length ? +Math.max(...errs.map((s) => s.errorMaxMm!)).toFixed(5) : 0,
        triangles: allStats.reduce((s, p) => s + p.triangles, 0),
        sourceTriangles: allStats.reduce((s, p) => s + p.sourceTriangles, 0),
      },
      thumbnails,
      disclaimer: DISCLAIMER,
      files,
    };
    void meshBytes;
    write("registration.json", JSON.stringify(c.registration ?? { performed: false, method: "none", scansPresent: false, note: "" }, null, 2));
    metadata.files["registration.json"] = files["registration.json"];
    write("metadata.json", JSON.stringify(metadata, null, 2));
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    renameSync(tmp, outDir);
    return metadata;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Merge all parts of a stage (debug / previews). */
export function stageMesh(stage: Stage): Mesh {
  return mergeMeshes(stage.parts.map((p) => p.mesh));
}
