/**
 * Arch geometry analysis: finds an arch's occlusal-plane normal, its anterior
 * direction (the closed end of the U), and which way the crowns point.
 * Used for orientation normalisation, jaw guessing and FDI estimation.
 */
import type { Jaw } from "@dentosim/canonical";
import { cross, dot, normalize, pca, scale, sub, type Vec3 } from "../math/linalg.js";
import { sampleSurface, type Mesh } from "../mesh/mesh.js";

export interface ArchAxes {
  centroid: Vec3;
  /** occlusal-plane normal (sign NOT yet resolved) */
  normal: Vec3;
  /** unit vector toward the incisors, in the occlusal plane */
  anterior: Vec3;
  /** how U-shaped the footprint is (0 = no evidence, larger = clearer) */
  uScore: number;
  /** principal variances, largest first */
  variances: Vec3;
}

/** Deterministic surface samples (tessellation-independent). */
export function archSamples(m: Mesh, n = 6000): Float32Array {
  return sampleSurface(m, n, 12345);
}

/**
 * Plane of the arch = two largest principal axes; anterior = in-plane direction
 * for which the far end is narrow (incisors) and the near end is wide (molars).
 */
export function archAxes(samples: Float32Array): ArchAxes {
  const p = pca(samples);
  const [a0, a1, normal] = p.axes;
  const n = samples.length / 3;
  const u = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = sub([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]], p.centroid);
    u[i] = dot(d, a0);
    v[i] = dot(d, a1);
  }
  let best = -Infinity, bestTheta = 0;
  const proj = new Float64Array(n), perp = new Float64Array(n);
  for (let deg = 0; deg < 360; deg += 3) {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    for (let i = 0; i < n; i++) {
      proj[i] = c * u[i] + s * v[i];
      perp[i] = -s * u[i] + c * v[i];
    }
    const sorted = Float64Array.from(proj).sort();
    const hiCut = sorted[Math.floor(n * 0.85)], loCut = sorted[Math.floor(n * 0.15)];
    const front = spread(perp, proj, (x) => x >= hiCut);
    const back = spread(perp, proj, (x) => x <= loCut);
    const score = back - front;
    if (score > best) { best = score; bestTheta = t; }
  }
  const anterior = normalize([
    Math.cos(bestTheta) * a0[0] + Math.sin(bestTheta) * a1[0],
    Math.cos(bestTheta) * a0[1] + Math.sin(bestTheta) * a1[1],
    Math.cos(bestTheta) * a0[2] + Math.sin(bestTheta) * a1[2],
  ]);
  const width = Math.sqrt(p.variances[0]);
  return { centroid: p.centroid, normal, anterior, uScore: width > 0 ? best / width : 0, variances: p.variances };
}

function spread(perp: Float64Array, proj: Float64Array, pick: (x: number) => boolean): number {
  let s = 0, s2 = 0, c = 0;
  for (let i = 0; i < perp.length; i++)
    if (pick(proj[i])) { s += perp[i]; s2 += perp[i] * perp[i]; c++; }
  if (c === 0) return 0;
  const m = s / c;
  return Math.sqrt(Math.max(0, s2 / c - m * m));
}

/** 2-D occupancy (mm² of 1 mm cells) of the points within a slab at one end of `axis`. */
function endOccupancy(samples: Float32Array, centroid: Vec3, axis: Vec3, e0: Vec3, e1: Vec3, top: boolean, fraction = 0.12): number {
  const n = samples.length / 3;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = dot(sub([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]], centroid), axis);
  const sorted = Float64Array.from(h).sort();
  const lo = sorted[0], hi = sorted[n - 1];
  const cut = top ? hi - (hi - lo) * fraction : lo + (hi - lo) * fraction;
  const cells = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (top ? h[i] < cut : h[i] > cut) continue;
    const d = sub([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]], centroid);
    const a = Math.floor(dot(d, e0)), b = Math.floor(dot(d, e1));
    cells.add((a + 5000) * 10000 + (b + 5000));
  }
  return cells.size;
}

/**
 * Direction the crowns point, along ±normal. With segmentation, teeth vs gums
 * centroids decide it; without, the end of the arch with the smaller footprint
 * (cusp tips) is the occlusal end — the other end is the gum rim or model base.
 */
export function crownDirection(samples: Float32Array, axes: ArchAxes, teethCentroid?: Vec3, softCentroid?: Vec3): { dir: Vec3; confidence: number } {
  if (teethCentroid && softCentroid) {
    const s = dot(sub(teethCentroid, softCentroid), axes.normal);
    if (Math.abs(s) > 0.5) return { dir: s > 0 ? axes.normal : scale(axes.normal, -1), confidence: 0.95 };
  }
  const e1 = normalize(cross(axes.normal, axes.anterior));
  const top = endOccupancy(samples, axes.centroid, axes.normal, axes.anterior, e1, true);
  const bottom = endOccupancy(samples, axes.centroid, axes.normal, axes.anterior, e1, false);
  const ratio = Math.max(top, bottom) / Math.max(1, Math.min(top, bottom));
  return { dir: top < bottom ? axes.normal : scale(axes.normal, -1), confidence: Math.min(0.9, 0.4 + (ratio - 1) * 0.5) };
}

/**
 * Guess the jaw from geometry alone: an upper model usually includes the palate
 * (the inside of the U is covered), a lower model has the tongue space (empty).
 * Returns the jaw plus a confidence; callers must treat < 0.7 as "ask the user".
 */
export function palateCoverage(samples: Float32Array, axes: ArchAxes): number {
  const e1 = normalize(cross(axes.normal, axes.anterior));
  const n = samples.length / 3;
  let minA = Infinity, maxA = -Infinity;
  const a = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = sub([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]], axes.centroid);
    a[i] = dot(d, axes.anterior);
    b[i] = dot(d, e1);
    if (a[i] < minA) minA = a[i];
    if (a[i] > maxA) maxA = a[i];
  }
  // probe points on the midline between 35% and 65% from the posterior end
  let covered = 0, probes = 0;
  for (let f = 0.35; f <= 0.651; f += 0.075) {
    const pa = minA + (maxA - minA) * f;
    probes++;
    for (let i = 0; i < n; i++) {
      if (Math.abs(a[i] - pa) < 2.5 && Math.abs(b[i]) < 2.5) { covered++; break; }
    }
  }
  return covered / probes;
}

export function guessJawFromGeometry(m: Mesh): { jaw: Jaw; confidence: number; palate: number } {
  const s = archSamples(m);
  const axes = archAxes(s);
  const palate = palateCoverage(s, axes);
  return palate >= 0.6 ? { jaw: "upper", confidence: 0.75, palate } : { jaw: "lower", confidence: 0.55, palate };
}
