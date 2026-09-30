/**
 * Triangle bounding-volume hierarchy for exact point-to-surface distance
 * queries (registration fit statistics and compression error measurement).
 */
export class TriangleBvh {
  private readonly pos: Float32Array;
  private readonly tri: Uint32Array; // triangle order (indices into original triangle list)
  private readonly ind: Uint32Array;
  private readonly bmin: number[] = [];
  private readonly bmax: number[] = [];
  private readonly lo: number[] = [];
  private readonly hi: number[] = [];
  private readonly left: number[] = [];
  private readonly right: number[] = [];
  private readonly cent: Float32Array;

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.pos = positions;
    this.ind = indices;
    const n = indices.length / 3;
    this.tri = new Uint32Array(n);
    this.cent = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      this.tri[t] = t;
      for (let k = 0; k < 3; k++) {
        this.cent[t * 3 + k] =
          (positions[indices[t * 3] * 3 + k] + positions[indices[t * 3 + 1] * 3 + k] + positions[indices[t * 3 + 2] * 3 + k]) / 3;
      }
    }
    if (n > 0) this.build(0, n);
  }

  private build(lo: number, hi: number): number {
    const node = this.lo.length;
    this.lo.push(lo);
    this.hi.push(hi);
    this.left.push(-1);
    this.right.push(-1);
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = this.tri[i];
      for (let v = 0; v < 3; v++) {
        const j = this.ind[t * 3 + v] * 3;
        const x = this.pos[j], y = this.pos[j + 1], z = this.pos[j + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
    }
    this.bmin.push(mnx, mny, mnz);
    this.bmax.push(mxx, mxy, mxz);
    if (hi - lo <= 4) return node;
    const ex = mxx - mnx, ey = mxy - mny, ez = mxz - mnz;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = (lo + hi) >> 1;
    this.select(lo, hi - 1, mid, axis);
    const l = this.build(lo, mid);
    const r = this.build(mid, hi);
    this.left[node] = l;
    this.right[node] = r;
    return node;
  }

  /** quickselect on tri[lo..hi] by centroid along axis so tri[k] is the median */
  private select(lo: number, hi: number, k: number, axis: number): void {
    const c = this.cent, t = this.tri;
    while (hi > lo) {
      const pivot = c[t[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (c[t[i] * 3 + axis] < pivot) i++;
        while (c[t[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const tmp = t[i]; t[i] = t[j]; t[j] = tmp;
          i++; j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  private boxDist2(node: number, x: number, y: number, z: number): number {
    const b = node * 3;
    const dx = Math.max(this.bmin[b] - x, 0, x - this.bmax[b]);
    const dy = Math.max(this.bmin[b + 1] - y, 0, y - this.bmax[b + 1]);
    const dz = Math.max(this.bmin[b + 2] - z, 0, z - this.bmax[b + 2]);
    return dx * dx + dy * dy + dz * dz;
  }

  /** Squared distance from (x,y,z) to the closest point on the surface. */
  distance2(x: number, y: number, z: number, maxDist2 = Infinity): number {
    if (this.tri.length === 0) return Infinity;
    let best = maxDist2;
    const stack: number[] = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (this.boxDist2(node, x, y, z) >= best) continue;
      if (this.left[node] < 0) {
        for (let i = this.lo[node]; i < this.hi[node]; i++) {
          const d = this.triDist2(this.tri[i], x, y, z);
          if (d < best) best = d;
        }
        continue;
      }
      const l = this.left[node], r = this.right[node];
      const dl = this.boxDist2(l, x, y, z), dr = this.boxDist2(r, x, y, z);
      if (dl < dr) { stack.push(r, l); } else { stack.push(l, r); }
    }
    return best;
  }

  /** Ericson, Real-Time Collision Detection §5.1.5 */
  private triDist2(t: number, px: number, py: number, pz: number): number {
    const P = this.pos, I = this.ind;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
    const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let qx: number, qy: number, qz: number;
    if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
    else {
      const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      const vc = d1 * d4 - d3 * d2;
      const vb = d5 * d2 - d1 * d6;
      const va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) { qx = P[b]; qy = P[b + 1]; qz = P[b + 2]; }
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else if (d6 >= 0 && d5 <= d6) { qx = P[c]; qy = P[c + 1]; qz = P[c + 2]; }
      else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        qx = P[b] + w * (P[c] - P[b]); qy = P[b + 1] + w * (P[c + 1] - P[b + 1]); qz = P[b + 2] + w * (P[c + 2] - P[b + 2]);
      } else {
        const denom = 1 / (va + vb + vc);
        const v = vb * denom, w = vc * denom;
        qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
      }
    }
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }
}
