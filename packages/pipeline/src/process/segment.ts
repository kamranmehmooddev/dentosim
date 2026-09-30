/**
 * Segmentation by mesh connectivity (no AI): most exports store gums, each
 * tooth and each attachment as separate shells inside one model file.
 *
 *  - largest shell (arch-sized) → gums; other arch-sized shells → base
 *  - tooth-sized shells → teeth
 *  - small shells → attachments; tiny shells (embossed text, debris) → dropped
 *  - an over-long tooth shell with a waist → fused last molars, split at the waist
 *  - a single shell → left whole and flagged "unsegmented"
 *  - only teeth, no gum shell → flagged for procedural (illustrative) gums
 *
 * Tooth identities are then tracked across stages by nearest centroid.
 */
import type { CanonicalCase, CaseWarning, Jaw, Part, SegmentationReport, Stage } from "@dentosim/canonical";
import { dot, pca, sub, type Vec3 } from "../math/linalg.js";
import { bounds, connectedComponents, diagonal, extractTriangles, surfaceArea, surfaceCentroid, weld, type Mesh } from "../mesh/mesh.js";

export interface SegmentOptions {
  /** shells smaller than this (bbox diagonal, mm) are dropped as fragments/text */
  fragmentDiagMm: number;
  /** shells with bbox diagonal ≥ this fraction of the arch diagonal are gums/base */
  archShellFraction: number;
  /** a tooth whose length exceeds this multiple of the median tooth length is a fusion candidate */
  fusedLengthRatio: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  fragmentDiagMm: 1.6,
  archShellFraction: 0.5,
  fusedLengthRatio: 1.6,
};

interface Shell {
  mesh: Mesh;
  area: number;
  diag: number;
  centroid: Vec3;
  length: number; // extent along the main principal axis
}

function shellOf(mesh: Mesh): Shell {
  const p = pca(mesh.positions);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = dot(sub([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]], p.centroid), p.axes[0]);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { mesh, area: surfaceArea(mesh), diag: diagonal(bounds(mesh.positions)), centroid: surfaceCentroid(mesh), length: hi - lo };
}

export interface StageSegmentation {
  gums?: Mesh;
  bases: Mesh[];
  teeth: Mesh[];
  attachments: Mesh[];
  dropped: number;
  fusedSplit: number;
  unsegmented: boolean;
}

/** Split one full-arch model into gums / teeth / attachments. */
export function segmentModel(model: Mesh, opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): StageSegmentation {
  const welded = weld(model);
  const comps = connectedComponents(welded);
  const archDiag = diagonal(bounds(welded.positions));
  const out: StageSegmentation = { bases: [], teeth: [], attachments: [], dropped: 0, fusedSplit: 0, unsegmented: false };
  if (comps.length <= 1) {
    out.unsegmented = true;
    return out;
  }
  const shells = comps.map((tris) => shellOf(extractTriangles(welded, tris)));
  shells.sort((a, b) => b.area - a.area);
  const rest: Shell[] = [];
  for (const s of shells) {
    if (s.diag >= opts.archShellFraction * archDiag) {
      if (!out.gums) out.gums = s.mesh;
      else out.bases.push(s.mesh);
    } else if (s.diag < opts.fragmentDiagMm) out.dropped++;
    else rest.push(s);
  }
  if (rest.length === 0) {
    // nothing but arch-sized shells (and dropped debris): teeth are fused into the gums
    out.unsegmented = true;
    return out;
  }
  // tooth size reference = median of the larger half of the remaining shells
  const byArea = [...rest].sort((a, b) => b.area - a.area);
  const big = byArea.slice(0, Math.max(1, Math.ceil(byArea.length / 2)));
  const refArea = big[big.length >> 1].area;
  const teeth = rest.filter((s) => s.area >= 0.25 * refArea);
  for (const s of rest) if (s.area < 0.25 * refArea) out.attachments.push(s.mesh);
  const lengths = teeth.map((t) => t.length).sort((a, b) => a - b);
  const medLen = lengths[lengths.length >> 1];
  for (const t of teeth) {
    if (teeth.length >= 4 && t.length > opts.fusedLengthRatio * medLen) {
      const split = splitAtWaist(t.mesh);
      if (split) {
        out.teeth.push(...split);
        out.fusedSplit++;
        continue;
      }
    }
    out.teeth.push(t.mesh);
  }
  return out;
}

/** Split a fused pair of teeth at the narrowest cross-section along its long axis. */
export function splitAtWaist(m: Mesh): [Mesh, Mesh] | undefined {
  const p = pca(m.positions);
  const axis = p.axes[0];
  const n = m.positions.length / 3;
  const t = new Float64Array(n), r = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = sub([m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]], p.centroid);
    t[i] = dot(d, axis);
    const along = t[i];
    r[i] = Math.sqrt(Math.max(0, dot(d, d) - along * along));
    lo = Math.min(lo, t[i]);
    hi = Math.max(hi, t[i]);
  }
  const bins = 24;
  const maxR = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor(((t[i] - lo) / (hi - lo)) * bins));
    if (r[i] > maxR[b]) maxR[b] = r[i];
  }
  let best = -1, bestR = Infinity;
  for (let b = Math.floor(bins * 0.3); b <= Math.ceil(bins * 0.7); b++)
    if (maxR[b] > 0 && maxR[b] < bestR) { bestR = maxR[b]; best = b; }
  if (best < 0) return undefined;
  const lobeL = Math.max(...maxR.slice(Math.floor(bins * 0.1), Math.floor(bins * 0.35)));
  const lobeR = Math.max(...maxR.slice(Math.ceil(bins * 0.65), Math.ceil(bins * 0.9)));
  if (bestR > 0.85 * Math.min(lobeL, lobeR)) return undefined; // no clear waist
  const cut = lo + ((best + 0.5) / bins) * (hi - lo);
  const a: number[] = [], b: number[] = [];
  for (let tri = 0; tri < m.indices.length / 3; tri++) {
    const c = (t[m.indices[tri * 3]] + t[m.indices[tri * 3 + 1]] + t[m.indices[tri * 3 + 2]]) / 3;
    (c < cut ? a : b).push(tri);
  }
  if (a.length < 8 || b.length < 8) return undefined;
  return [extractTriangles(m, a), extractTriangles(m, b)];
}

/**
 * Segment every "arch" part of every stage, then give teeth stable ids across
 * stages. Parts the export already separated (tooth/gums/…) are kept.
 */
export function segmentCase(c: CanonicalCase, opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): SegmentationReport {
  const report: SegmentationReport = { performed: false, jaws: {} };
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const arch = c.arches[jaw];
    if (!arch) continue;
    let stage0Summary: NonNullable<SegmentationReport["jaws"][Jaw]> | undefined;
    for (const stage of arch.stages) {
      const archParts = stage.parts.filter((p) => p.kind === "arch");
      const kept = stage.parts.filter((p) => p.kind !== "arch");
      if (archParts.length === 0) {
        stage.segmented = kept.some((p) => p.kind === "tooth");
        stage0Summary ??= summary(kept, 0, 0, false);
        continue;
      }
      report.performed = true;
      const parts: Part[] = [...kept];
      let dropped = 0, fused = 0, unsegmented = false;
      for (const ap of archParts) {
        const seg = segmentModel(ap.mesh, opts);
        dropped += seg.dropped;
        fused += seg.fusedSplit;
        if (seg.unsegmented) {
          unsegmented = true;
          parts.push({ id: uniqueId(parts, "arch"), kind: "arch", mesh: seg.gums ?? ap.mesh });
          seg.bases.forEach((m) => parts.push({ id: uniqueId(parts, "base"), kind: "base", mesh: m }));
          continue;
        }
        if (seg.gums) parts.push({ id: uniqueId(parts, "gums"), kind: "gums", mesh: seg.gums });
        seg.bases.forEach((m) => parts.push({ id: uniqueId(parts, "base"), kind: "base", mesh: m }));
        seg.teeth.forEach((m, i) => parts.push({ id: uniqueId(parts, `tooth-s${i}`), kind: "tooth", mesh: m }));
        seg.attachments.forEach((m, i) => parts.push({ id: uniqueId(parts, `attachment-${i}`), kind: "attachment", mesh: m }));
      }
      stage.parts = parts;
      stage.segmented = !unsegmented && parts.some((p) => p.kind === "tooth");
      if (stage.index === 0) stage0Summary = summary(parts, dropped, fused, unsegmented);
      if (dropped > 0 && stage.index === 0)
        c.warnings.push({ code: "FRAGMENTS_DROPPED", severity: "info", jaw, message: `${cap(jaw)} arch: ${dropped} tiny fragment(s) (e.g. embossed text) were removed.` });
      if (fused > 0 && stage.index === 0)
        c.warnings.push({ code: "FUSED_TEETH_SPLIT", severity: "warning", jaw, message: `${cap(jaw)} arch: ${fused} fused tooth shell(s) were split at the narrowest point; please check the last molars.` });
    }
    if (stage0Summary?.unsegmented)
      c.warnings.push({
        code: "UNSEGMENTED",
        severity: "warning",
        jaw,
        message: `${cap(jaw)} arch: teeth and gums are one connected surface in this export, so teeth cannot be selected individually and gum colour is approximate.`,
      });
    if (stage0Summary && stage0Summary.teeth > 0 && !arch.stages[0].parts.some((p) => p.kind === "gums" || p.kind === "arch")) {
      stage0Summary.proceduralGums = true;
      c.warnings.push({ code: "PROCEDURAL_GUMS", severity: "info", jaw, message: `${cap(jaw)} arch: the export has no gum model; illustrative gums are shown.` });
    }
    if (stage0Summary) report.jaws[jaw] = stage0Summary;
    trackIdentities(arch.stages, jaw, c.warnings);
  }
  return report;
}

function summary(parts: Part[], dropped: number, fused: number, unsegmented: boolean) {
  return {
    teeth: parts.filter((p) => p.kind === "tooth").length,
    attachments: parts.filter((p) => p.kind === "attachment").length,
    droppedFragments: dropped,
    fusedSplit: fused,
    unsegmented,
    proceduralGums: false,
  };
}

function uniqueId(parts: Part[], base: string): string {
  let id = base;
  for (let k = 2; parts.some((p) => p.id === id); k++) id = `${base}-${k}`;
  return id;
}

/**
 * Give teeth (and attachments) the same id in every stage: stage k parts are
 * matched to stage k-1 parts by nearest centroid (greedy, closest pairs first).
 * Parts that already carry an FDI number keep "tooth-<fdi>".
 */
export function trackIdentities(stages: Stage[], jaw: Jaw, warnings: CaseWarning[]): void {
  let next = 1;
  const seed = stages[0];
  if (!seed) return;
  for (const p of seed.parts)
    if (p.kind === "tooth" && p.fdi === undefined) p.id = `tooth-t${next++}`;
  let nextAtt = 1;
  for (const p of seed.parts) if (p.kind === "attachment") p.id = `attachment-a${nextAtt++}`;
  let unmatched = 0;
  for (let k = 1; k < stages.length; k++) {
    for (const kind of ["tooth", "attachment"] as const) {
      const prev = stages[k - 1].parts.filter((p) => p.kind === kind && (kind === "attachment" || p.fdi === undefined));
      const cur = stages[k].parts.filter((p) => p.kind === kind && (kind === "attachment" || p.fdi === undefined));
      const pc = prev.map((p) => surfaceCentroid(p.mesh));
      const cc = cur.map((p) => surfaceCentroid(p.mesh));
      const pairs: [number, number, number][] = [];
      for (let i = 0; i < cur.length; i++)
        for (let j = 0; j < prev.length; j++) pairs.push([Math.hypot(...sub(cc[i], pc[j])), i, j]);
      pairs.sort((a, b) => a[0] - b[0]);
      const usedC = new Set<number>(), usedP = new Set<number>();
      const limit = kind === "tooth" ? 6 : 4; // mm a part may move between consecutive stages
      for (const [d, i, j] of pairs) {
        if (usedC.has(i) || usedP.has(j) || d > limit) continue;
        usedC.add(i);
        usedP.add(j);
        cur[i].id = prev[j].id;
      }
      for (let i = 0; i < cur.length; i++)
        if (!usedC.has(i)) {
          if (kind === "tooth") { cur[i].id = `tooth-t${next++}`; unmatched++; }
          else cur[i].id = `attachment-a${nextAtt++}`;
        }
    }
    // keep ids unique within the stage
    const seen = new Set<string>();
    for (const p of stages[k].parts) {
      let id = p.id;
      for (let n = 2; seen.has(id); n++) id = `${p.id}-${n}`;
      p.id = id;
      seen.add(id);
    }
  }
  if (unmatched)
    warnings.push({ code: "TOOTH_TRACKING", severity: "info", jaw, message: `${cap(jaw)} arch: ${unmatched} tooth shell(s) could not be followed from one stage to the next (extraction or re-segmentation).` });
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
