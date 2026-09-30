/**
 * Bite registration: rigidly align each arch of the export (stage 0) to the
 * patient's scan of that arch, then carry the same transform to every stage.
 *
 * Method: PCA multi-start + trimmed ICP (the worst 25 % of correspondences are
 * ignored every iteration). Rigid only — rotation + translation, never scale or
 * mirror (Horn's quaternion solution is a proper rotation by construction).
 * Fit statistics are exact point-to-surface distances (triangle BVH).
 */
import type { CanonicalCase, CaseWarning, Jaw, RegistrationFit, RegistrationReport } from "@dentosim/canonical";
import { TriangleBvh } from "../math/bvh.js";
import { KdTree } from "../math/kdtree.js";
import {
  bestRigid, fromBasis, identity4, invertRigid, median, multiply4, pca, rigidFromRotationVector, rotationAngleDeg, scale,
  solveLinear, transformPositions, translation4, trimmedMean, type Mat4, type Vec3,
} from "../math/linalg.js";
import { mergeMeshes, sampleSurface, sampleSurfaceWithNormals, transformMesh, type Mesh } from "../mesh/mesh.js";

export interface IcpOptions {
  /** fraction of correspondences kept each iteration */
  keep: number;
  maxIterations: number;
  coarsePoints: number;
  finePoints: number;
  targetPoints: number;
  /** stop when the transform update moves points less than this (mm) */
  tolerance: number;
}

export const DEFAULT_ICP: IcpOptions = { keep: 0.75, maxIterations: 40, coarsePoints: 1000, finePoints: 6000, targetPoints: 80_000, tolerance: 1e-4 };

export interface RigidFit {
  matrix: Mat4;
  trimmedMeanMm: number;
  iterations: number;
}

/**
 * Trimmed ICP from a starting transform. `src` are points, `tree` indexes target
 * points. With `targetNormals`, iterations after the first few minimise the
 * point-to-plane distance (much faster convergence on smooth dental surfaces).
 */
export function trimmedIcp(src: Float32Array, tree: KdTree, start: Mat4, opts: IcpOptions, targetNormals?: Float32Array): RigidFit {
  const n = src.length / 3;
  let M = start.slice();
  const moved = new Float32Array(src.length);
  const nearest = new Float32Array(src.length);
  const dist = new Float64Array(n);
  const d2 = new Float64Array(1);
  const P = new Float64Array(n * 3), Q = new Float64Array(n * 3), N = new Float64Array(n * 3);
  const nearestIdx = new Int32Array(n);
  let err = Infinity, it = 0;
  for (; it < opts.maxIterations; it++) {
    const cur = transformPositions(M, src);
    moved.set(cur);
    for (let i = 0; i < n; i++) {
      const j = tree.nearest(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2], d2);
      dist[i] = d2[0];
      nearestIdx[i] = j;
      nearest[i * 3] = tree.points[j * 3];
      nearest[i * 3 + 1] = tree.points[j * 3 + 1];
      nearest[i * 3 + 2] = tree.points[j * 3 + 2];
    }
    const sorted = Float64Array.from(dist).sort();
    const cutoff = sorted[Math.max(0, Math.floor(n * opts.keep) - 1)];
    let m = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      if (dist[i] > cutoff) continue;
      P[m * 3] = moved[i * 3]; P[m * 3 + 1] = moved[i * 3 + 1]; P[m * 3 + 2] = moved[i * 3 + 2];
      Q[m * 3] = nearest[i * 3]; Q[m * 3 + 1] = nearest[i * 3 + 1]; Q[m * 3 + 2] = nearest[i * 3 + 2];
      if (targetNormals) {
        const j = nearestIdx[i] * 3;
        N[m * 3] = targetNormals[j]; N[m * 3 + 1] = targetNormals[j + 1]; N[m * 3 + 2] = targetNormals[j + 2];
      }
      if (targetNormals) {
        // point-to-plane residual: independent of the target sampling density
        const j = nearestIdx[i] * 3;
        sum += Math.abs((moved[i * 3] - nearest[i * 3]) * targetNormals[j] + (moved[i * 3 + 1] - nearest[i * 3 + 1]) * targetNormals[j + 1] + (moved[i * 3 + 2] - nearest[i * 3 + 2]) * targetNormals[j + 2]);
      } else sum += Math.sqrt(dist[i]);
      m++;
    }
    err = sum / Math.max(1, m);
    const step = (targetNormals && it >= 3 ? pointToPlaneStep(P, Q, N, m) : undefined) ?? bestRigid(P, Q, m);
    M = multiply4(step, M);
    // convergence: how far does the update move a point at the cloud's radius?
    const moveMm = Math.hypot(step[12], step[13], step[14]) + (rotationAngleDeg(step) * Math.PI / 180) * 40;
    if (moveMm < opts.tolerance) { it++; break; }
  }
  return { matrix: M, trimmedMeanMm: err, iterations: it };
}

/** One linearised point-to-plane step (small-angle), returned as an exact rigid transform. */
function pointToPlaneStep(P: Float64Array, Q: Float64Array, N: Float64Array, m: number): Mat4 | undefined {
  const AtA = new Array<number>(36).fill(0), Atb = new Array<number>(6).fill(0);
  const a = new Array<number>(6);
  for (let i = 0; i < m; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    a[0] = py * nz - pz * ny; a[1] = pz * nx - px * nz; a[2] = px * ny - py * nx;
    a[3] = nx; a[4] = ny; a[5] = nz;
    const b = (Q[i * 3] - px) * nx + (Q[i * 3 + 1] - py) * ny + (Q[i * 3 + 2] - pz) * nz;
    for (let r = 0; r < 6; r++) {
      Atb[r] += a[r] * b;
      for (let c = r; c < 6; c++) AtA[r * 6 + c] += a[r] * a[c];
    }
  }
  for (let r = 0; r < 6; r++) for (let c = 0; c < r; c++) AtA[r * 6 + c] = AtA[c * 6 + r];
  const x = solveLinear(AtA, Atb, 6);
  if (!x || x.some((v) => !Number.isFinite(v))) return undefined;
  return rigidFromRotationVector([x[0], x[1], x[2]], [x[3], x[4], x[5]]);
}

/** Starting poses: identity + principal-axis alignments (4 proper sign combinations). */
export function pcaStarts(src: Float32Array, dst: Float32Array): Mat4[] {
  const a = pca(src), b = pca(dst);
  const starts: Mat4[] = [identity4()];
  const toA = invertRigid(fromBasis(a.axes[0], a.axes[1], a.axes[2], a.centroid)); // world → A frame
  for (const [s0, s1] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const b0 = scale(b.axes[0], s0), b1 = scale(b.axes[1], s1);
    const b2: Vec3 = [b0[1] * b1[2] - b0[2] * b1[1], b0[2] * b1[0] - b0[0] * b1[2], b0[0] * b1[1] - b0[1] * b1[0]];
    starts.push(multiply4(fromBasis(b0, b1, b2, b.centroid), toA));
  }
  // translation-only start (common when the export is roughly aligned)
  starts.push(translation4([b.centroid[0] - a.centroid[0], b.centroid[1] - a.centroid[1], b.centroid[2] - a.centroid[2]]));
  return starts;
}

export interface Registration {
  fit: RegistrationFit;
}

/**
 * Register `source` onto `target`. The global search (multi-start) uses
 * `source`; the final refinement uses `fineSource` when given (e.g. search on
 * teeth + gums, whose shape is unambiguous, then refine on teeth only, which
 * are the most reliable surfaces in an export).
 */
export function registerMeshes(source: Mesh, target: Mesh, opts: IcpOptions = DEFAULT_ICP, fineSource: Mesh = source): RegistrationFit {
  const { points: tgtPts, normals: tgtNormals } = sampleSurfaceWithNormals(target, opts.targetPoints, 99);
  const tree = new KdTree(tgtPts);
  const coarse = sampleSurface(source, opts.coarsePoints, 5);
  const starts = pcaStarts(sampleSurface(source, 20_000, 3), tgtPts);
  const candidates = starts
    .map((s) => trimmedIcp(coarse, tree, s, { ...opts, maxIterations: 25, tolerance: 1e-3 }, tgtNormals))
    .sort((a, b) => a.trimmedMeanMm - b.trimmedMeanMm);
  // refine the two best basins on the full search source, keep the better one
  const mid = sampleSurface(source, opts.finePoints, 6);
  const refined = candidates.slice(0, 2).map((c) => trimmedIcp(mid, tree, c.matrix, opts, tgtNormals)).sort((a, b) => a.trimmedMeanMm - b.trimmedMeanMm);
  const fine = fineSource === source ? refined[0] : trimmedIcp(sampleSurface(fineSource, opts.finePoints, 7), tree, refined[0].matrix, opts, tgtNormals);
  // exact point-to-surface statistics on independent samples
  const bvh = new TriangleBvh(target.positions, target.indices);
  const check = transformPositions(fine.matrix, sampleSurface(fineSource, 20_000, 77));
  const d = new Float64Array(check.length / 3);
  for (let i = 0; i < d.length; i++) d[i] = Math.sqrt(bvh.distance2(check[i * 3], check[i * 3 + 1], check[i * 3 + 2]));
  const sorted = Float64Array.from(d).sort();
  const kept = sorted.subarray(0, Math.floor(sorted.length * opts.keep));
  const rms = Math.sqrt(kept.reduce((s, v) => s + v * v, 0) / Math.max(1, kept.length));
  return {
    matrix: fine.matrix.map((v) => +v.toFixed(9)),
    trimmedMeanMm: +trimmedMean(d, opts.keep).toFixed(4),
    medianMm: +median(d).toFixed(4),
    rmsMm: +rms.toFixed(4),
    inlierFraction: opts.keep,
    iterations: fine.iterations,
    starts: starts.length,
  };
}

/**
 * Stage-0 surfaces used against a scan: `search` = teeth + gums (overall shape,
 * unambiguous orientation), `fine` = teeth only (exports' gums are often
 * virtual or trimmed; crowns are the reliable surfaces). Never bases/attachments.
 */
function registrationSources(c: CanonicalCase, jaw: Jaw): { search: Mesh; fine: Mesh } {
  const parts = c.arches[jaw]!.stages[0].parts;
  const useful = parts.filter((p) => p.kind === "tooth" || p.kind === "gums" || p.kind === "arch");
  const teeth = parts.filter((p) => p.kind === "tooth");
  const search = mergeMeshes((useful.length ? useful : parts).map((p) => p.mesh));
  return { search, fine: teeth.length >= 4 ? mergeMeshes(teeth.map((p) => p.mesh)) : search };
}

export function registerCase(c: CanonicalCase, opts: IcpOptions = DEFAULT_ICP): RegistrationReport {
  const scans = c.scans ?? {};
  const scansPresent = !!(scans.upper || scans.lower);
  if (!scansPresent) {
    return {
      performed: false,
      method: "none",
      scansPresent: false,
      note: "No patient scans were provided, so the bite shown is the relationship stored in the export itself.",
    };
  }
  const report: RegistrationReport = { performed: true, method: "pca-multistart-trimmed-icp", scansPresent: true, note: "" };
  const transforms: Partial<Record<Jaw, Mat4>> = {};
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const scan = scans[jaw];
    if (!scan || !c.arches[jaw]) continue;
    const src = registrationSources(c, jaw);
    const fit = registerMeshes(src.search, scan, opts, src.fine);
    report[jaw] = fit;
    transforms[jaw] = fit.matrix;
  }
  // one scan only: move both arches with it so the export's own bite is kept
  const jaws = (["upper", "lower"] as Jaw[]).filter((j) => c.arches[j]);
  if (jaws.length === 2 && Object.keys(transforms).length === 1) {
    const only = Object.values(transforms)[0]!;
    for (const j of jaws) transforms[j] ??= only;
  }
  for (const j of jaws) {
    const T = transforms[j];
    if (!T) continue;
    for (const st of c.arches[j]!.stages) for (const p of st.parts) p.mesh = transformMesh(p.mesh, T);
  }
  const fits = [report.upper, report.lower].filter(Boolean) as RegistrationFit[];
  const worst = Math.max(...fits.map((f) => f.trimmedMeanMm));
  const warn = (w: CaseWarning) => c.warnings.push(w);
  if (worst > 0.3)
    warn({
      code: "REGISTRATION_POOR_FIT",
      severity: "warning",
      message: `The treatment plan fits the patient scans poorly (trimmed mean ${worst.toFixed(2)} mm). Check that the scans belong to this patient and were taken before treatment.`,
    });
  if (scans.bite) {
    const both = mergeMeshes(jaws.map((j) => mergeMeshes(c.arches[j]!.stages[0].parts.map((p) => p.mesh))));
    const bvh = new TriangleBvh(both.positions, both.indices);
    const s = sampleSurface(scans.bite, 5000, 11);
    const d = new Float64Array(s.length / 3);
    for (let i = 0; i < d.length; i++) d[i] = Math.sqrt(bvh.distance2(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]));
    report.biteConsistencyMedianMm = +median(d).toFixed(4);
    if (report.biteConsistencyMedianMm > 0.5)
      warn({
        code: "BITE_SCAN_INCONSISTENT",
        severity: "warning",
        message: `The bite scan does not match the registered arches (median ${report.biteConsistencyMedianMm.toFixed(2)} mm); upper and lower scans may not have been exported in occlusion.`,
      });
  }
  const parts = fits.map((f, i) => `${fits.length === 2 ? (i === 0 ? "upper " : "lower ") : ""}trimmed mean ${f.trimmedMeanMm.toFixed(3)} mm, median ${f.medianMm.toFixed(3)} mm`);
  report.note =
    jaws.length === 2 && fits.length === 1
      ? `Only one arch was scanned; that arch was registered (${parts[0]}) and the other arch keeps the export's bite relationship.`
      : `Bite taken from the patient scans (${parts.join("; ")}).`;
  return report;
}
