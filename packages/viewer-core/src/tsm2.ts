/** Browser TSM2 decoder (spec: docs/tsm2.md). */
import { MeshoptDecoder } from "meshoptimizer";

export type PartKind = "tooth" | "gums" | "attachment" | "base" | "arch";

export interface Tsm2PartHeader {
  id: string;
  kind: PartKind;
  fdi?: number;
  fdiEstimated?: boolean;
  procedural?: boolean;
  vertexCount: number;
  triangleCount: number;
  quantization: { bits: 16; offset: [number, number, number]; scale: [number, number, number] };
  vertices: { encoding: "meshopt-vertex"; stride: 8; byteOffset: number; byteLength: number };
  indices: { encoding: "meshopt-index"; indexSize: 4; byteOffset: number; byteLength: number };
}

export interface Tsm2Header {
  format: "TSM2";
  version: number;
  units: "mm";
  coordinateSystem: string;
  jaw?: "upper" | "lower";
  stage?: number;
  content: "stage" | "scan";
  bounds: { min: [number, number, number]; max: [number, number, number] };
  parts: Tsm2PartHeader[];
}

export interface DecodedPart extends Omit<Tsm2PartHeader, "vertices" | "indices"> {
  positions: Float32Array;
  normals: Float32Array;
  /** triangle list */
  triangles: Uint32Array;
}

export interface DecodedTsm2 {
  header: Tsm2Header;
  parts: DecodedPart[];
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class Tsm2DecodeError extends Error {}

/** Smooth vertex normals (area-weighted). */
export function computeNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

export async function decodeTsm2(buf: ArrayBuffer | Uint8Array, opts: { verifyCrc?: boolean } = {}): Promise<DecodedTsm2> {
  await MeshoptDecoder.ready;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 20 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "TSM2") throw new Tsm2DecodeError("not a TSM2 file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(4, true) !== 1) throw new Tsm2DecodeError("unsupported TSM2 version");
  const hl = dv.getUint32(8, true), bl = dv.getUint32(12, true);
  if (20 + hl + bl !== bytes.length) throw new Tsm2DecodeError("TSM2 length mismatch");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + hl))) as Tsm2Header;
  const body = bytes.subarray(20 + hl);
  if (opts.verifyCrc !== false && crc32(body) !== dv.getUint32(16, true)) throw new Tsm2DecodeError("TSM2 checksum mismatch");
  const parts = header.parts.map((p) => {
    const q = new Uint8Array(p.vertexCount * 8);
    MeshoptDecoder.decodeVertexBuffer(q, p.vertexCount, 8, body.subarray(p.vertices.byteOffset, p.vertices.byteOffset + p.vertices.byteLength));
    const ib = new Uint8Array(p.triangleCount * 12);
    MeshoptDecoder.decodeIndexBuffer(ib, p.triangleCount * 3, 4, body.subarray(p.indices.byteOffset, p.indices.byteOffset + p.indices.byteLength));
    const q16 = new Uint16Array(q.buffer);
    const positions = new Float32Array(p.vertexCount * 3);
    const [ox, oy, oz] = p.quantization.offset, [sx, sy, sz] = p.quantization.scale;
    for (let i = 0; i < p.vertexCount; i++) {
      positions[i * 3] = ox + q16[i * 4] * sx;
      positions[i * 3 + 1] = oy + q16[i * 4 + 1] * sy;
      positions[i * 3 + 2] = oz + q16[i * 4 + 2] * sz;
    }
    const triangles = new Uint32Array(ib.buffer);
    const { vertices: _v, indices: _i, ...meta } = p;
    return { ...meta, positions, triangles, normals: computeNormals(positions, triangles) };
  });
  return { header, parts };
}
