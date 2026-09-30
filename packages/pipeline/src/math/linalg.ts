/**
 * Small dense linear-algebra helpers. Matrices are 4×4 column-major
 * (same convention as glTF / three.js) stored in plain number arrays.
 */

export type Vec3 = [number, number, number];
export type Mat3 = number[]; // 9, row-major (only used internally for symmetric eigen problems)
export type Mat4 = number[]; // 16, column-major

export const identity4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Build a column-major 4×4 from a rotation given by its three column axes and a translation. */
export function fromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, t: Vec3 = [0, 0, 0]): Mat4 {
  return [...xAxis, 0, ...yAxis, 0, ...zAxis, 0, t[0], t[1], t[2], 1];
}

/** Rotation matrix (column-major 4×4) whose ROWS are the given axes: maps world → frame coordinates. */
export function toFrame(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, origin: Vec3): Mat4 {
  // R has rows x,y,z ; t = -R·origin
  const t: Vec3 = [-dot(xAxis, origin), -dot(yAxis, origin), -dot(zAxis, origin)];
  return [xAxis[0], yAxis[0], zAxis[0], 0, xAxis[1], yAxis[1], zAxis[1], 0, xAxis[2], yAxis[2], zAxis[2], 0, t[0], t[1], t[2], 1];
}

export function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

export function translation4(t: Vec3): Mat4 {
  const m = identity4();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}

export function scale4(s: number): Mat4 {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}

/** Inverse of a rigid transform (rotation + translation). */
export function invertRigid(m: Mat4): Mat4 {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  // transpose rotation
  const out: Mat4 = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  const t: Vec3 = [m[12], m[13], m[14]];
  out[12] = -(out[0] * t[0] + out[4] * t[1] + out[8] * t[2]);
  out[13] = -(out[1] * t[0] + out[5] * t[1] + out[9] * t[2]);
  out[14] = -(out[2] * t[0] + out[6] * t[1] + out[10] * t[2]);
  return out;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function transformDir(m: Mat4, p: Vec3): Vec3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
}

/** Apply a 4×4 transform to packed xyz positions (returns a new array). */
export function transformPositions(m: Mat4, pos: Float32Array): Float32Array {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Determinant of the upper-left 3×3 block. */
export function det3of4(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/** Rotation angle (degrees) of the rotation part of a rigid transform. */
export function rotationAngleDeg(m: Mat4): number {
  const tr = m[0] + m[5] + m[10];
  return (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
}

/**
 * Eigen-decomposition of a symmetric n×n matrix (row-major) by cyclic Jacobi.
 * Returns eigenvalues sorted descending and eigenvectors as rows (unit length).
 */
export function symmetricEigen(a: number[], n: number): { values: number[]; vectors: number[][] } {
  const A = a.slice();
  const V = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = A[p * n + p], aqq = A[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const order = [...Array(n).keys()].sort((i, j) => A[j * n + j] - A[i * n + i]);
  return {
    values: order.map((i) => A[i * n + i]),
    vectors: order.map((i) => [...Array(n).keys()].map((k) => V[k * n + i])),
  };
}

export interface Pca {
  centroid: Vec3;
  /** principal axes, largest variance first; right-handed (axes[2] = axes[0] × axes[1]) */
  axes: [Vec3, Vec3, Vec3];
  variances: Vec3;
}

/** PCA over packed xyz positions (optionally a stride-subsampled set). */
export function pca(pos: Float32Array, maxSamples = 200_000): Pca {
  const n = pos.length / 3;
  const step = Math.max(1, Math.floor(n / maxSamples));
  let cx = 0, cy = 0, cz = 0, m = 0;
  for (let i = 0; i < n; i += step) {
    cx += pos[i * 3];
    cy += pos[i * 3 + 1];
    cz += pos[i * 3 + 2];
    m++;
  }
  cx /= m;
  cy /= m;
  cz /= m;
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < n; i += step) {
    const x = pos[i * 3] - cx, y = pos[i * 3 + 1] - cy, z = pos[i * 3 + 2] - cz;
    C[0] += x * x; C[1] += x * y; C[2] += x * z;
    C[4] += y * y; C[5] += y * z; C[8] += z * z;
  }
  C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
  for (let i = 0; i < 9; i++) C[i] /= m;
  const { values, vectors } = symmetricEigen(C, 3);
  const a0 = normalize(vectors[0] as Vec3), a1 = normalize(vectors[1] as Vec3);
  return { centroid: [cx, cy, cz], axes: [a0, a1, cross(a0, a1)], variances: values as Vec3 };
}

/**
 * Best rigid transform (rotation + translation, never scale or mirror) mapping
 * point set P onto Q (Horn's closed-form quaternion method). P, Q are packed xyz,
 * `weights` optional. Returns a column-major 4×4.
 */
export function bestRigid(P: Float64Array | Float32Array, Q: Float64Array | Float32Array, count: number, weights?: Float64Array): Mat4 {
  let wsum = 0;
  const pc: Vec3 = [0, 0, 0], qc: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const w = weights ? weights[i] : 1;
    wsum += w;
    pc[0] += w * P[i * 3]; pc[1] += w * P[i * 3 + 1]; pc[2] += w * P[i * 3 + 2];
    qc[0] += w * Q[i * 3]; qc[1] += w * Q[i * 3 + 1]; qc[2] += w * Q[i * 3 + 2];
  }
  if (wsum === 0) return identity4();
  for (let k = 0; k < 3; k++) { pc[k] /= wsum; qc[k] /= wsum; }
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < count; i++) {
    const w = weights ? weights[i] : 1;
    const px = P[i * 3] - pc[0], py = P[i * 3 + 1] - pc[1], pz = P[i * 3 + 2] - pc[2];
    const qx = Q[i * 3] - qc[0], qy = Q[i * 3 + 1] - qc[1], qz = Q[i * 3 + 2] - qc[2];
    Sxx += w * px * qx; Sxy += w * px * qy; Sxz += w * px * qz;
    Syx += w * py * qx; Syy += w * py * qy; Syz += w * py * qz;
    Szx += w * pz * qx; Szy += w * pz * qy; Szz += w * pz * qz;
  }
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const { vectors } = symmetricEigen(N, 4);
  const [q0, qx, qy, qz] = vectors[0];
  const R = quatToMat3(q0, qx, qy, qz);
  const t: Vec3 = [
    qc[0] - (R[0] * pc[0] + R[1] * pc[1] + R[2] * pc[2]),
    qc[1] - (R[3] * pc[0] + R[4] * pc[1] + R[5] * pc[2]),
    qc[2] - (R[6] * pc[0] + R[7] * pc[1] + R[8] * pc[2]),
  ];
  // row-major R → column-major 4×4
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

/** Unit quaternion (w,x,y,z) → row-major 3×3 rotation. */
export function quatToMat3(w: number, x: number, y: number, z: number): Mat3 {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Column-major rigid 4×4 from Euler angles (radians, applied X then Y then Z) and a translation. */
export function rigidFromEuler(rx: number, ry: number, rz: number, t: Vec3 = [0, 0, 0]): Mat4 {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz * Ry * Rx (row-major)
  const R = [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

/** Rotation-part axis-angle of a rigid transform: unit axis and angle (radians). */
export function axisAngle(m: Mat4): { axis: Vec3; angle: number } {
  const angle = Math.acos(Math.min(1, Math.max(-1, (m[0] + m[5] + m[10] - 1) / 2)));
  if (angle < 1e-9) return { axis: [0, 0, 1], angle: 0 };
  // R(row,col): m[col*4+row]
  let axis: Vec3 = [m[6] - m[9], m[8] - m[2], m[1] - m[4]];
  if (length(axis) < 1e-9) {
    // angle ≈ π : axis from the largest diagonal term of (R + I)/2
    const xx = (m[0] + 1) / 2, yy = (m[5] + 1) / 2, zz = (m[10] + 1) / 2;
    if (xx >= yy && xx >= zz) axis = [Math.sqrt(xx), m[4] / (2 * Math.sqrt(xx)), m[8] / (2 * Math.sqrt(xx))];
    else if (yy >= zz) axis = [m[4] / (2 * Math.sqrt(yy)), Math.sqrt(yy), m[9] / (2 * Math.sqrt(yy))];
    else axis = [m[8] / (2 * Math.sqrt(zz)), m[9] / (2 * Math.sqrt(zz)), Math.sqrt(zz)];
  }
  return { axis: normalize(axis), angle };
}

export function median(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/** Mean of the smallest `keep` fraction of values. */
export function trimmedMean(values: ArrayLike<number>, keep = 0.75): number {
  if (values.length === 0) return 0;
  const s = Float64Array.from(values).sort();
  const n = Math.max(1, Math.floor(s.length * keep));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return sum / n;
}

/** Solve the n×n linear system A·x = b (row-major A) by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[], b: number[], n: number): number[] | undefined {
  const M = A.slice(), v = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
    if (Math.abs(M[piv * n + c]) < 1e-12) return undefined;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t; }
      const t = v[c]; v[c] = v[piv]; v[piv] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      v[r] -= f * v[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = v[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/** Rigid 4×4 from a rotation vector (axis × angle, radians; Rodrigues) and a translation. */
export function rigidFromRotationVector(w: Vec3, t: Vec3): Mat4 {
  const angle = length(w);
  if (angle < 1e-15) return translation4(t);
  const [x, y, z] = scale(w, 1 / angle);
  const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  // row-major R
  const R = [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}
