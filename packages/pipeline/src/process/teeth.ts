/**
 * Per-tooth post-processing in the normalised frame:
 *  - FDI numbering estimated from position when the export did not supply it
 *  - cumulative per-tooth movement (mm / degrees) for every stage
 *  - illustrative procedural gums for exports that contain teeth only
 */
import type { CanonicalCase, Jaw, Part, ToothMovement } from "@dentosim/canonical";
import { KdTree } from "../math/kdtree.js";
import { axisAngle, bestRigid, cross, dot, normalize, scale, sub, transformPoint, translation4, type Vec3 } from "../math/linalg.js";
import { mergeMeshes, sampleSurface, surfaceCentroid, type Mesh } from "../mesh/mesh.js";
import { DEFAULT_ICP, trimmedIcp } from "./register.js";

/**
 * Number teeth by position: patient right (−X) → quadrant 1 (upper) / 4 (lower),
 * patient left (+X) → 2 / 3; within a side, 1…8 from the midline backwards.
 * Missing teeth shift the numbering, hence "fdiEstimated".
 */
export function estimateFdi(c: CanonicalCase, jaw: Jaw): boolean {
  const arch = c.arches[jaw];
  if (!arch) return false;
  const teeth = arch.stages[0].parts.filter((p) => p.kind === "tooth");
  if (teeth.length === 0 || teeth.every((t) => t.fdi !== undefined)) return false;
  const cents = teeth.map((t) => surfaceCentroid(t.mesh));
  const xs = cents.map((p) => p[0]);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const sides: [number, Part[]][] = [
    [jaw === "upper" ? 1 : 4, []],
    [jaw === "upper" ? 2 : 3, []],
  ];
  const order = new Map<Part, number>();
  teeth.forEach((t, i) => {
    sides[cents[i][0] < mid ? 0 : 1][1].push(t);
    order.set(t, cents[i][2]);
  });
  if (sides.some(([, list]) => list.length > 8)) return false;
  const rename = new Map<string, string>();
  for (const [quadrant, list] of sides) {
    list.sort((a, b) => order.get(b)! - order.get(a)!); // most anterior first
    list.forEach((t, i) => {
      const fdi = quadrant * 10 + i + 1;
      rename.set(t.id, `tooth-${fdi}`);
      t.fdi = fdi;
      t.fdiEstimated = true;
    });
  }
  // propagate to every stage through the tracked ids
  for (const st of arch.stages.slice(1))
    for (const p of st.parts)
      if (p.kind === "tooth" && rename.has(p.id)) {
        const fdi = parseInt(rename.get(p.id)!.slice(6), 10);
        p.fdi = fdi;
        p.fdiEstimated = true;
      }
  for (const st of arch.stages) for (const p of st.parts) if (rename.has(p.id)) p.id = rename.get(p.id)!;
  c.warnings.push({
      code: "FDI_ESTIMATED",
      severity: "info",
      jaw,
      message: `${jaw === "upper" ? "Upper" : "Lower"} arch: tooth numbers were estimated from position (${sides.map(([q, l]) => `${l.length} in quadrant ${q}`).join(", ")}); numbering may be off if teeth are missing.`,
    });
  return true;
}

/** Rigid motion of a tooth from stage 0 to stage k. */
function toothMotion(a: Mesh, b: Mesh) {
  if (a.positions.length === b.positions.length && a.indices.length === b.indices.length) {
    // same topology (tooth mesh moved rigidly by the planning software): exact
    return bestRigid(a.positions, b.positions, a.positions.length / 3);
  }
  const src = sampleSurface(a, 1500, 3);
  const tree = new KdTree(sampleSurface(b, 6000, 4));
  const ca = surfaceCentroid(a), cb = surfaceCentroid(b);
  return trimmedIcp(src, tree, translation4(sub(cb, ca)), { ...DEFAULT_ICP, keep: 0.9, maxIterations: 30 }).matrix;
}

export function computeMovements(c: CanonicalCase): ToothMovement[] {
  const out: ToothMovement[] = [];
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const arch = c.arches[jaw];
    if (!arch || arch.stages.length < 2) continue;
    const t0 = arch.stages[0].parts.filter((p) => p.kind === "tooth");
    if (t0.length === 0) continue;
    const archCentre = surfaceCentroid(mergeMeshes(t0.map((t) => t.mesh)));
    const front: Vec3 = [archCentre[0], 0, Math.max(...t0.map((t) => surfaceCentroid(t.mesh)[2])) + 5];
    const crownDir: Vec3 = jaw === "upper" ? [0, -1, 0] : [0, 1, 0];
    for (const tooth of t0) {
      const c0 = surfaceCentroid(tooth.mesh);
      // tooth arch frame at stage 0
      const buccal = normalize([c0[0] - archCentre[0], 0, c0[2] - (archCentre[2] - 10)]);
      let mesial = normalize(cross([0, 1, 0], buccal));
      if (dot(mesial, sub(front, c0)) < 0) mesial = scale(mesial, -1);
      for (const st of arch.stages.slice(1)) {
        const cur = st.parts.find((p) => p.id === tooth.id);
        if (!cur) continue;
        const M = toothMotion(tooth.mesh, cur.mesh);
        const c1 = transformPoint(M, c0);
        const d = sub(c1, c0);
        const { axis, angle } = axisAngle(M);
        const rv = scale(axis, (angle * 180) / Math.PI);
        out.push({
          jaw,
          toothId: tooth.id,
          ...(tooth.fdi !== undefined ? { fdi: tooth.fdi } : {}),
          stage: st.index,
          translationMm: d.map((v) => +v.toFixed(3)) as Vec3,
          translationMagnitudeMm: +Math.hypot(...d).toFixed(3),
          mesialDistalMm: +dot(d, mesial).toFixed(3),
          buccalLingualMm: +dot(d, buccal).toFixed(3),
          extrusionIntrusionMm: +dot(d, crownDir).toFixed(3),
          rotationDeg: +((angle * 180) / Math.PI).toFixed(2),
          tipDeg: +dot(rv, buccal).toFixed(2),
          torqueDeg: +dot(rv, mesial).toFixed(2),
          rotationAboutLongAxisDeg: +dot(rv, [0, 1, 0]).toFixed(2),
        });
      }
    }
  }
  return out;
}

/**
 * Illustrative gums for teeth-only exports: a smooth band following the arch
 * through the tooth centroids, just above (upper) / below (lower) the crowns.
 */
export function proceduralGums(teeth: Mesh[], jaw: Jaw): Mesh {
  const cents = teeth.map((t) => surfaceCentroid(t));
  const cx = cents.reduce((s, p) => s + p[0], 0) / cents.length;
  const cz = cents.reduce((s, p) => s + p[2], 0) / cents.length - 8;
  // order along the arch by angle around a point behind the arch
  const sorted = [...cents].sort((a, b) => Math.atan2(a[0] - cx, a[2] - cz) - Math.atan2(b[0] - cx, b[2] - cz));
  const up = jaw === "upper" ? 1 : -1;
  const yTeeth = cents.reduce((s, p) => s + p[1], 0) / cents.length;
  const y0 = yTeeth + up * 1.5, y1 = yTeeth + up * 9;
  const ring = 12;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const prev = sorted[Math.max(0, i - 1)], next = sorted[Math.min(sorted.length - 1, i + 1)];
    const tangent = normalize([next[0] - prev[0], 0, next[2] - prev[2]]);
    const outward: Vec3 = [tangent[2], 0, -tangent[0]];
    for (let k = 0; k < ring; k++) {
      const a = (2 * Math.PI * k) / ring;
      const r = 5.5;
      const off = Math.cos(a) * r, h = ((Math.sin(a) + 1) / 2) * (y1 - y0);
      pos.push(p[0] + outward[0] * off, y0 + h, p[2] + outward[2] * off);
    }
  }
  for (let i = 0; i + 1 < sorted.length; i++)
    for (let k = 0; k < ring; k++) {
      const a = i * ring + k, b = i * ring + ((k + 1) % ring), c2 = (i + 1) * ring + k, d = (i + 1) * ring + ((k + 1) % ring);
      idx.push(a, c2, b, b, c2, d);
    }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

export function addProceduralGums(c: CanonicalCase): void {
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const arch = c.arches[jaw];
    if (!arch || !c.segmentation?.jaws[jaw]?.proceduralGums) continue;
    for (const st of arch.stages) {
      const teeth = st.parts.filter((p) => p.kind === "tooth").map((p) => p.mesh);
      if (teeth.length < 2 || st.parts.some((p) => p.kind === "gums")) continue;
      st.parts.push({ id: "gums", kind: "gums", procedural: true, mesh: proceduralGums(teeth, jaw) });
    }
  }
}
