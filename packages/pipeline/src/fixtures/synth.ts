/**
 * Deterministic synthetic dentition generator.
 *
 * Produces anatomically-plausible (not anatomically-accurate) arches in the
 * DentoSim frame (+X patient left, +Y up, +Z anterior, mm): separate tooth
 * shells, gingiva (with palate for the upper arch), attachments and tiny
 * embossed-text fragments, plus staged tooth movements and simulated patient
 * scans. Used for the generic-format fixtures, unit tests and benchmarks.
 * Real vendor fixtures must come from real (anonymised) exports.
 */
import type { Jaw } from "@dentosim/canonical";
import { add, cross, multiply4, normalize, rigidFromEuler, scale, translation4, transformPositions, type Mat4, type Vec3 } from "../math/linalg.js";
import { mergeMeshes, type Mesh } from "../mesh/mesh.js";

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  gauss(): number {
    const u = Math.max(1e-12, this.next()), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Closed UV-sphere-like tooth shell with cusp modulation. */
export function toothShell(radii: Vec3, lat = 10, lon = 16, cusp = 0.1, waist = 0): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  // poles + rings
  pos.push(0, -radii[1], 0);
  for (let i = 1; i < lat; i++) {
    const th = (Math.PI * i) / lat - Math.PI / 2; // -90..90
    for (let j = 0; j < lon; j++) {
      const ph = (2 * Math.PI * j) / lon;
      const x = Math.cos(th) * Math.cos(ph), y = Math.sin(th), z = Math.cos(th) * Math.sin(ph);
      let r = 1 + cusp * Math.max(0, y) * Math.sin(3 * ph) * Math.cos(2 * th);
      if (waist) r *= 1 - waist * Math.exp(-((x * 2.2) ** 2));
      pos.push(x * radii[0] * r, y * radii[1] * r, z * radii[2] * r);
    }
  }
  pos.push(0, radii[1], 0);
  const top = pos.length / 3 - 1;
  const ring = (i: number, j: number) => 1 + (i - 1) * lon + (j % lon);
  for (let j = 0; j < lon; j++) idx.push(0, ring(1, j), ring(1, j + 1));
  for (let i = 1; i < lat - 1; i++)
    for (let j = 0; j < lon; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  for (let j = 0; j < lon; j++) idx.push(ring(lat - 1, j), top, ring(lat - 1, j + 1));
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

export function box(size: Vec3): Mesh {
  const [x, y, z] = size.map((s) => s / 2);
  const p = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z];
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
  return { positions: Float32Array.from(p), indices: Uint32Array.from(i) };
}

/** Prism: extrude a closed outline (xz) between y0 and y1; caps triangulated as a ladder between rails A and B. */
function prism(railA: [number, number][], railB: [number, number][], y0: number, y1: number): Mesh {
  // outline = A forward + B backward
  const loop = [...railA, ...[...railB].reverse()];
  const n = loop.length;
  const pos: number[] = [];
  for (const [x, z] of loop) pos.push(x, y0, z);
  for (const [x, z] of loop) pos.push(x, y1, z);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n, c = i + n, d = ((i + 1) % n) + n;
    idx.push(a, b, d, a, d, c);
  }
  // caps: ladder between A[k] and B[k]
  const m = railA.length;
  const Ai = (k: number) => k, Bi = (k: number) => n - 1 - k;
  for (let k = 0; k + 1 < m; k++) {
    const a0 = Ai(k), a1 = Ai(k + 1), b0 = Bi(k), b1 = Bi(k + 1);
    for (const off of [0, n]) {
      const tri = (p: number, q: number, r: number) => {
        if (p !== q && q !== r && p !== r) idx.push(p + off, q + off, r + off);
      };
      if (off === 0) { tri(a0, b0, a1); tri(a1, b0, b1); }
      else { tri(a0, a1, b0); tri(a1, b1, b0); }
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/**
 * Closed shell swept through `levels` (y, inset): each level is the outline
 * A(inset) + reverse(B(inset)); caps at the first and last level are ladders
 * between A and B. Rails must have equal point counts at every level.
 */
function roundedShell(levels: { y: number; inset: number }[], railA: (d: number) => [number, number][], railB: (d: number) => [number, number][]): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  let n = 0, m = 0;
  for (const L of levels) {
    const a = railA(L.inset), b = railB(L.inset);
    m = a.length;
    const loop = [...a, ...[...b].reverse()];
    n = loop.length;
    for (const [x, z] of loop) pos.push(x, L.y, z);
  }
  const ring = (l: number, i: number) => l * n + ((i + n) % n);
  for (let l = 0; l + 1 < levels.length; l++)
    for (let i = 0; i < n; i++) {
      const a = ring(l, i), b = ring(l, i + 1), c = ring(l + 1, i), d = ring(l + 1, i + 1);
      idx.push(a, b, d, a, d, c);
    }
  const cap = (l: number, flip: boolean) => {
    for (let k = 0; k + 1 < m; k++) {
      const a0 = ring(l, k), a1 = ring(l, k + 1), b0 = ring(l, n - 1 - k), b1 = ring(l, n - 2 - k);
      const tri = (p: number, q: number, r: number) => {
        if (p !== q && q !== r && p !== r) idx.push(...(flip ? [p, r, q] : [p, q, r]));
      };
      tri(a0, b0, a1);
      tri(a1, b0, b1);
    }
  };
  cap(0, false);
  cap(levels.length - 1, true);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

interface ToothSpec {
  fdi: number;
  md: number;
  bl: number;
  h: number;
}

const UPPER_TEETH: [number, number, number][] = [
  [8.5, 7, 10.5], [6.6, 6.2, 9.5], [7.6, 8, 11], [7, 9, 9], [6.6, 9, 8.5], [10.2, 11, 8], [9.2, 10.8, 7.8],
];
const LOWER_TEETH: [number, number, number][] = [
  [5.4, 6, 9], [5.9, 6.2, 9.2], [6.9, 7.6, 10.5], [7, 7.8, 9], [7.1, 8.2, 8.5], [11, 10.5, 8], [10.4, 10.2, 7.8],
];

export interface ArchOptions {
  jaw: Jaw;
  seed: number;
  stages: number; // number of stages after the initial one (N) → N+1 models
  attachments?: boolean;
  embossedText?: boolean;
  /** fuse the last two molars of quadrant 1/4 into one shell */
  fusedMolar?: boolean;
  /** make one connected shell (teeth + gums) — unsegmentable */
  singleShell?: boolean;
  /** tooth tessellation */
  lat?: number;
  lon?: number;
  maxTranslationMm?: number;
  maxRotationDeg?: number;
}

export interface SynthTooth {
  fdi: number;
  center: Vec3;
  /** local frame: md (tangent), bl (buccal), y */
  frame: [Vec3, Vec3, Vec3];
  mesh: Mesh; // at stage 0, world coords
  attachment?: Mesh;
  /** final movement relative to stage 0, about the tooth center */
  finalRot: Vec3; // euler radians in tooth frame
  finalTrans: Vec3; // world mm
}

export interface SynthArch {
  jaw: Jaw;
  teeth: SynthTooth[];
  gums: Mesh;
  text: Mesh[];
  stages: number;
  opts: ArchOptions;
}

function archCurve(jaw: Jaw): { a: number; b: number; zShift: number } {
  return jaw === "upper" ? { a: 27, b: 40, zShift: -12 } : { a: 24.5, b: 36, zShift: -11.5 };
}

export function makeArch(opts: ArchOptions): SynthArch {
  const rng = new Rng(opts.seed);
  const { a, b, zShift } = archCurve(opts.jaw);
  const up = opts.jaw === "upper" ? 1 : -1;
  const specs = opts.jaw === "upper" ? UPPER_TEETH : LOWER_TEETH;
  const C = (phi: number): Vec3 => [a * Math.sin(phi), 0, b * Math.cos(phi) + zShift];
  // arc-length parametrisation
  const steps = 2000, phiMax = (115 * Math.PI) / 180;
  const table: number[] = [0];
  for (let i = 1; i <= steps; i++) {
    const p0 = C(((i - 1) / steps) * phiMax), p1 = C((i / steps) * phiMax);
    table.push(table[i - 1] + Math.hypot(p1[0] - p0[0], p1[2] - p0[2]));
  }
  const phiAt = (s: number) => {
    let i = table.findIndex((v) => v >= s);
    if (i < 0) i = steps;
    return (i / steps) * phiMax;
  };
  const teeth: SynthTooth[] = [];
  const maxT = opts.maxTranslationMm ?? 1.2, maxR = ((opts.maxRotationDeg ?? 10) * Math.PI) / 180;
  let lastPhi = 0;
  for (const side of [-1, 1]) {
    let s = 0;
    specs.forEach(([md, bl, h], k) => {
      const fdi = (opts.jaw === "upper" ? (side < 0 ? 10 : 20) : side < 0 ? 40 : 30) + k + 1;
      const phi = side * phiAt(s + md / 2);
      s += md;
      if (side > 0) lastPhi = Math.max(lastPhi, Math.abs(phi));
      const c = C(phi);
      const tangent = normalize([a * Math.cos(phi), 0, -b * Math.sin(phi)]);
      const buccal = normalize([b * Math.sin(phi), 0, a * Math.cos(phi)]);
      const center: Vec3 = [c[0], up * (h / 2 - 0.3), c[2]];
      teeth.push({
        fdi, center, frame: [tangent, buccal, [0, 1, 0]],
        mesh: { positions: new Float32Array(), indices: new Uint32Array() },
        finalRot: [rng.range(-maxR, maxR), rng.range(-maxR, maxR), rng.range(-maxR, maxR)],
        finalTrans: [rng.range(-maxT, maxT), rng.range(-maxT, maxT) * 0.4, rng.range(-maxT, maxT)],
        ...({ _spec: { md, bl, h } } as object),
      });
    });
  }
  const phiEnd = lastPhi + 0.06;
  // build tooth meshes
  const byFdi = new Map(teeth.map((t) => [t.fdi, t]));
  for (const t of teeth) {
    const { md, bl, h } = (t as unknown as { _spec: { md: number; bl: number; h: number } })._spec;
    let local = toothShell([md / 2, h / 2, bl / 2], opts.lat ?? 10, opts.lon ?? 16, 0.12);
    // frame: local x = tangent, local y = up, local z = buccal
    const place = (m: Mesh, center: Vec3) => transformPositions([...t.frame[0], 0, 0, 1, 0, 0, ...t.frame[1], 0, center[0], center[1], center[2], 1], m.positions);
    if (opts.fusedMolar && (t.fdi === 16 || t.fdi === 46)) {
      const next = byFdi.get(t.fdi + 1)!;
      const nspec = (next as unknown as { _spec: { md: number } })._spec;
      const totalMd = md + nspec.md;
      local = toothShell([totalMd / 2, h / 2, bl / 2], opts.lat ?? 12, (opts.lon ?? 16) + 8, 0.1, 0.45);
      const mid: Vec3 = scale(add(t.center, next.center), 0.5);
      t.center = mid;
      t.mesh = { positions: place(local, mid), indices: local.indices };
      teeth.splice(teeth.indexOf(next), 1);
      continue;
    }
    t.mesh = { positions: place(local, t.center), indices: local.indices };
    if (opts.attachments && [3, 4, 5].includes(t.fdi % 10)) {
      const att = box([3, 2, 1.2]);
      const ac = add(t.center, scale(t.frame[1], bl / 2 + 0.1));
      t.attachment = { positions: place(att, ac), indices: att.indices };
    }
  }
  // gums: outer/inner rails along the arch
  const rail = (offset: number, from: number, to: number, n: number): [number, number][] => {
    const r: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const phi = from + ((to - from) * i) / n;
      const c = C(phi);
      const nrm = normalize([b * Math.sin(phi), 0, a * Math.cos(phi)]);
      r.push([c[0] + nrm[0] * offset, c[2] + nrm[2] * offset]);
    }
    return r;
  };
  // gingiva: extruded from the model base toward the teeth with a rounded
  // (quarter-round) margin, so it reads as soft tissue rather than a slab
  const yBase = up * 11.5, yMargin = up * 3.6, R = 4.6;
  const levels: { y: number; inset: number }[] = [{ y: yBase, inset: 0 }];
  const straightEnd = yMargin + up * R;
  levels.push({ y: straightEnd, inset: 0 });
  for (let k = 1; k <= 6; k++) {
    const t = (k / 6) * (Math.PI / 2);
    levels.push({ y: straightEnd - up * R * Math.sin(t), inset: R * (1 - Math.cos(t)) * 0.9 });
  }
  const gums = opts.jaw === "upper"
    // palate: ladder between the left and right halves of the outer rail
    ? roundedShell(levels, (d) => rail(6.5 - d, 0, phiEnd, 48), (d) => rail(6.5 - d, 0, -phiEnd, 48))
    : roundedShell(levels, (d) => rail(6.5 - d, -phiEnd, phiEnd, 96), (d) => rail(-6.5 + d, -phiEnd, phiEnd, 96));
  const text: Mesh[] = [];
  if (opts.embossedText)
    for (let i = 0; i < 5; i++) {
      const g = box([0.7, 0.5, 0.9]);
      text.push({ positions: transformPositions(translation4([-3 + i * 1.3, up * 11.7, zShift - 4]), g.positions), indices: g.indices });
    }
  const arch: SynthArch = { jaw: opts.jaw, teeth, gums, text, stages: opts.stages, opts };
  return arch;
}

/** Rigid transform of a tooth at stage k (fraction f = k / N). */
export function toothTransform(t: SynthTooth, f: number): Mat4 {
  const [tx, ty, tz] = t.finalRot.map((r) => r * f) as Vec3;
  // rotation in the tooth frame about its center: T(c + d) · B · R · Bᵀ · T(-c)
  const B: Mat4 = [...t.frame[0], 0, ...t.frame[2], 0, ...t.frame[1], 0, 0, 0, 0, 1];
  const Bt: Mat4 = [B[0], B[4], B[8], 0, B[1], B[5], B[9], 0, B[2], B[6], B[10], 0, 0, 0, 0, 1];
  const R = rigidFromEuler(tx, ty, tz);
  const d = scale(t.finalTrans, f);
  return multiply4(translation4(add(t.center, d)), multiply4(B, multiply4(R, multiply4(Bt, translation4(scale(t.center, -1))))));
}

export interface StageModel {
  teeth: { fdi: number; mesh: Mesh }[];
  attachments: Mesh[];
  gums: Mesh;
  text: Mesh[];
  /** everything merged as one multi-shell model (what most exports contain) */
  full: Mesh;
}

export function stageModel(arch: SynthArch, k: number): StageModel {
  const f = arch.stages === 0 ? 0 : Math.min(1, k / arch.stages);
  const teeth = arch.teeth.map((t) => ({ fdi: t.fdi, mesh: { positions: transformPositions(toothTransform(t, f), t.mesh.positions), indices: t.mesh.indices } }));
  const attachments = arch.teeth.filter((t) => t.attachment).map((t) => ({ positions: transformPositions(toothTransform(t, f), t.attachment!.positions), indices: t.attachment!.indices }));
  const parts = [arch.gums, ...teeth.map((t) => t.mesh), ...attachments, ...arch.text];
  let full = mergeMeshes(parts);
  if (arch.opts.singleShell) full = singleShellArch(arch, teeth.map((t) => t.mesh));
  return { teeth, attachments, gums: arch.gums, text: arch.text, full };
}

/**
 * One connected shell: a heightfield over the gum footprint with tooth bumps.
 * (Simulates exports where teeth and gingiva are fused.)
 */
function singleShellArch(arch: SynthArch, teeth: Mesh[]): Mesh {
  const up = arch.jaw === "upper" ? 1 : -1;
  const centers = teeth.map((m) => {
    let x = 0, z = 0;
    for (let i = 0; i < m.positions.length; i += 3) { x += m.positions[i]; z += m.positions[i + 2]; }
    return [x / (m.positions.length / 3), z / (m.positions.length / 3)] as [number, number];
  });
  const W = 70, D = 60, n = 90;
  const pos: number[] = [];
  const keep: boolean[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const x = -W / 2 + (W * i) / n, z = -D / 2 - 8 + (D * j) / n;
      let hgt = 0, inside = false;
      for (const [cx, cz] of centers) {
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (d2 < 49) inside = true;
        hgt = Math.max(hgt, 9 * Math.exp(-d2 / 12));
      }
      keep.push(inside);
      pos.push(x, up * (8 - hgt), z);
    }
  const idx: number[] = [];
  const id = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (!(keep[id(i, j)] && keep[id(i + 1, j)] && keep[id(i, j + 1)] && keep[id(i + 1, j + 1)])) continue;
      idx.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  // keep only the largest connected region implicitly by construction (arch ring)
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** Simulated intra-oral scan of stage 0: denser tessellation, no attachments/text, noise. */
export function scanOf(arch: SynthArch, seed: number, noiseMm = 0.02): Mesh {
  const hi = makeArch({ ...arch.opts, attachments: false, embossedText: false, lat: 14, lon: 24 });
  const s0 = stageModel(hi, 0);
  const m = mergeMeshes([s0.gums, ...s0.teeth.map((t) => t.mesh)]);
  const rng = new Rng(seed);
  const p = new Float32Array(m.positions);
  for (let i = 0; i < p.length; i++) p[i] += rng.gauss() * noiseMm;
  return { positions: p, indices: m.indices };
}

export const unitVec = (v: Vec3) => normalize(v);
export const crossVec = cross;
