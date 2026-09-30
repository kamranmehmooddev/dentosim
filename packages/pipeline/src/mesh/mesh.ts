import type { MeshData } from "@dentosim/canonical";
import { transformPositions, type Mat4, type Vec3 } from "../math/linalg.js";

export type Mesh = MeshData;

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export const vertexCount = (m: Mesh): number => m.positions.length / 3;
export const triangleCount = (m: Mesh): number => m.indices.length / 3;

export function bounds(pos: Float32Array): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max };
}

export const extent = (b: Bounds): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const diagonal = (b: Bounds): number => Math.hypot(...extent(b));

export function transformMesh(m: Mesh, mat: Mat4): Mesh {
  return { positions: transformPositions(mat, m.positions), indices: m.indices };
}

export function scaleMesh(m: Mesh, s: number): Mesh {
  if (s === 1) return m;
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i++) p[i] = m.positions[i] * s;
  return { positions: p, indices: m.indices };
}

export function mergeMeshes(meshes: Mesh[]): Mesh {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** Surface area of each triangle. */
export function triangleAreas(m: Mesh): Float64Array {
  const n = m.indices.length / 3, out = new Float64Array(n), p = m.positions, I = m.indices;
  for (let t = 0; t < n; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    out[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return out;
}

export function surfaceArea(m: Mesh): number {
  return triangleAreas(m).reduce((s, a) => s + a, 0);
}

/** Area-weighted surface centroid. */
export function surfaceCentroid(m: Mesh): Vec3 {
  const areas = triangleAreas(m), p = m.positions, I = m.indices;
  let sx = 0, sy = 0, sz = 0, sa = 0;
  for (let t = 0; t < areas.length; t++) {
    const a = areas[t];
    for (let v = 0; v < 3; v++) {
      const j = I[t * 3 + v] * 3;
      sx += (a * p[j]) / 3; sy += (a * p[j + 1]) / 3; sz += (a * p[j + 2]) / 3;
    }
    sa += a;
  }
  if (sa === 0) return [0, 0, 0];
  return [sx / sa, sy / sa, sz / sa];
}

/** Signed volume (positive for closed, outward-oriented meshes). */
export function signedVolume(m: Mesh): number {
  const p = m.positions, I = m.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * Merge vertices that share the same position (to `tolerance` mm) and drop
 * degenerate triangles. STL stores every triangle's corners separately, so
 * welding is required before connectivity analysis.
 */
export function weld(m: Mesh, tolerance = 1e-5): Mesh {
  const n = m.positions.length / 3;
  const inv = 1 / tolerance;
  const remap = new Uint32Array(n);
  const p = m.positions;
  // open-addressing hash table keyed on quantised coordinates
  let cap = 1;
  while (cap < n * 2) cap <<= 1;
  const slots = new Int32Array(cap).fill(-1); // → output vertex id
  const qx = new Float64Array(n), qy = new Float64Array(n), qz = new Float64Array(n); // per output vertex
  const out = new Float32Array(n * 3);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.round(p[i * 3] * inv), y = Math.round(p[i * 3 + 1] * inv), z = Math.round(p[i * 3 + 2] * inv);
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & (cap - 1);
    let id = -1;
    for (;;) {
      const s = slots[h];
      if (s < 0) break;
      if (qx[s] === x && qy[s] === y && qz[s] === z) { id = s; break; }
      h = (h + 1) & (cap - 1);
    }
    if (id < 0) {
      id = count++;
      slots[h] = id;
      qx[id] = x; qy[id] = y; qz[id] = z;
      out[id * 3] = p[i * 3]; out[id * 3 + 1] = p[i * 3 + 1]; out[id * 3 + 2] = p[i * 3 + 2];
    }
    remap[i] = id;
  }
  const idx = new Uint32Array(m.indices.length);
  let ni = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = remap[m.indices[t]], b = remap[m.indices[t + 1]], c = remap[m.indices[t + 2]];
    if (a !== b && b !== c && a !== c) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; }
  }
  return { positions: out.slice(0, count * 3), indices: idx.slice(0, ni) };
}

/** Connected components by shared vertices. Returns triangle-index lists, largest first. */
export function connectedComponents(m: Mesh): Uint32Array[] {
  const nv = m.positions.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]), b = find(I[t + 1]), c = find(I[t + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < I.length / 3; t++) {
    const r = find(I[t * 3]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length).map((g) => Uint32Array.from(g));
}

/** Extract a compact sub-mesh consisting of the given triangles. */
export function extractTriangles(m: Mesh, tris: ArrayLike<number>): Mesh {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    for (let v = 0; v < 3; v++) {
      const old = m.indices[t * 3 + v];
      let id = remap.get(old);
      if (id === undefined) {
        id = pos.length / 3;
        remap.set(old, id);
        pos.push(m.positions[old * 3], m.positions[old * 3 + 1], m.positions[old * 3 + 2]);
      }
      idx[i * 3 + v] = id;
    }
  }
  return { positions: Float32Array.from(pos), indices: idx };
}

/** Evenly subsample up to `max` vertex positions (deterministic). */
export function samplePositions(pos: Float32Array, max: number): Float32Array {
  const n = pos.length / 3;
  if (n <= max) return pos;
  const out = new Float32Array(max * 3);
  const step = n / max;
  for (let i = 0; i < max; i++) {
    const j = Math.floor(i * step) * 3;
    out[i * 3] = pos[j]; out[i * 3 + 1] = pos[j + 1]; out[i * 3 + 2] = pos[j + 2];
  }
  return out;
}

/**
 * Area-uniform surface samples (deterministic): better than vertices for
 * comparing meshes with different tessellation.
 */
export function sampleSurface(m: Mesh, count: number, seed = 1): Float32Array {
  return sampleSurfaceWithNormals(m, count, seed).points;
}

/** Area-uniform surface samples plus the unit normal of the triangle each sample lies on. */
export function sampleSurfaceWithNormals(m: Mesh, count: number, seed = 1): { points: Float32Array; normals: Float32Array } {
  const areas = triangleAreas(m);
  const cdf = new Float64Array(areas.length);
  let s = 0;
  for (let i = 0; i < areas.length; i++) { s += areas[i]; cdf[i] = s; }
  const out = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  if (s === 0) return { points: new Float32Array(0), normals: new Float32Array(0) };
  let state = seed >>> 0 || 1;
  const rnd = () => {
    // xorshift32
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  const p = m.positions, I = m.indices;
  for (let i = 0; i < count; i++) {
    const r = rnd() * s;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = I[lo * 3] * 3, b = I[lo * 3 + 1] * 3, c = I[lo * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = p[a + k] + u * (p[b + k] - p[a + k]) + v * (p[c + k] - p[a + k]);
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
  }
  return { points: out, normals: nrm };
}

/** Stable content hash of geometry (for duplicate detection). */
export function geometryKey(m: Mesh): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const u = new Uint32Array(m.positions.buffer, m.positions.byteOffset, m.positions.length);
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 16777619);
    h2 = Math.imul(h2 + u[i], 2246822519) ^ (h2 >>> 13);
  }
  return `${m.positions.length}:${m.indices.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}
