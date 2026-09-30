/**
 * Static 3-D k-d tree over packed xyz points for nearest-neighbour queries
 * (used by ICP registration and by mesh-to-mesh error measurement).
 */
export class KdTree {
  readonly points: Float32Array;
  private readonly idx: Uint32Array;
  // node arrays (implicit balanced tree over idx ranges)
  private readonly leafSize = 8;
  private readonly nodeLo: number[] = [];
  private readonly nodeHi: number[] = [];
  private readonly nodeAxis: number[] = [];
  private readonly nodeSplit: number[] = [];
  private readonly nodeLeft: number[] = [];
  private readonly nodeRight: number[] = [];

  constructor(points: Float32Array) {
    this.points = points;
    const n = points.length / 3;
    this.idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.idx[i] = i;
    if (n > 0) this.build(0, n);
  }

  get size(): number {
    return this.idx.length;
  }

  private build(lo: number, hi: number): number {
    const node = this.nodeLo.length;
    this.nodeLo.push(lo);
    this.nodeHi.push(hi);
    this.nodeAxis.push(-1);
    this.nodeSplit.push(0);
    this.nodeLeft.push(-1);
    this.nodeRight.push(-1);
    if (hi - lo <= this.leafSize) return node;
    // split on the axis with largest extent
    const p = this.points;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = lo; i < hi; i++) {
      const j = this.idx[i] * 3;
      const x = p[j], y = p[j + 1], z = p[j + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    const ex = maxx - minx, ey = maxy - miny, ez = maxz - minz;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = (lo + hi) >> 1;
    this.select(lo, hi - 1, mid, axis);
    this.nodeAxis[node] = axis;
    this.nodeSplit[node] = p[this.idx[mid] * 3 + axis];
    const l = this.build(lo, mid);
    const r = this.build(mid, hi);
    this.nodeLeft[node] = l;
    this.nodeRight[node] = r;
    return node;
  }

  /** Hoare quickselect on idx[lo..hi] so idx[k] holds the k-th smallest along axis. */
  private select(lo: number, hi: number, k: number, axis: number): void {
    const p = this.points, idx = this.idx;
    while (hi > lo) {
      const pivot = p[idx[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (p[idx[i] * 3 + axis] < pivot) i++;
        while (p[idx[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
          i++; j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  /**
   * Nearest point to (x,y,z). Returns the point index and writes the squared
   * distance into `out[0]` (avoids allocation in hot loops). -1 if empty.
   */
  nearest(x: number, y: number, z: number, out: Float64Array, maxDist2 = Infinity): number {
    if (this.idx.length === 0) return -1;
    const p = this.points, idx = this.idx;
    let best = -1, bestD = maxDist2;
    const stack: number[] = [0];
    const stackD: number[] = [0];
    while (stack.length) {
      const node = stack.pop()!;
      const nd = stackD.pop()!;
      if (nd >= bestD) continue;
      const axis = this.nodeAxis[node];
      if (axis < 0) {
        for (let i = this.nodeLo[node], hi = this.nodeHi[node]; i < hi; i++) {
          const j = idx[i] * 3;
          const dx = p[j] - x, dy = p[j + 1] - y, dz = p[j + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = idx[i]; }
        }
        continue;
      }
      const q = axis === 0 ? x : axis === 1 ? y : z;
      const diff = q - this.nodeSplit[node];
      const near = diff < 0 ? this.nodeLeft[node] : this.nodeRight[node];
      const far = diff < 0 ? this.nodeRight[node] : this.nodeLeft[node];
      // push far first so near is processed first
      stack.push(far); stackD.push(Math.max(nd, diff * diff));
      stack.push(near); stackD.push(nd);
    }
    out[0] = bestD;
    return best;
  }
}
