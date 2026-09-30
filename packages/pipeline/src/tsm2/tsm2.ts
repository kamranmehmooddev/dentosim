/**
 * TSM2 — DentoSim's compact binary mesh container (one file per arch per stage).
 * Specification: docs/tsm2.md.
 *
 *   offset  size  field
 *   0       4     magic "TSM2"
 *   4       2     u16 format version (1)
 *   6       2     u16 flags (reserved, 0)
 *   8       4     u32 header byte length H (UTF-8 JSON, space-padded to a multiple of 4)
 *   12      4     u32 body byte length B
 *   16      4     u32 CRC-32 (IEEE) of the body
 *   20      H     header JSON
 *   20+H    B     body: per part, meshopt-encoded vertex buffer then index buffer,
 *                 each 4-byte aligned; offsets in the header are relative to the body
 *
 * Vertices: positions quantised to 16-bit unsigned per axis over the part's
 * bounding box (x,y,z,pad → stride 8), encoded with meshopt vertex codec.
 * Indices: 32-bit triangle list encoded with meshopt index codec.
 * Normals are not stored; the viewer computes smooth normals.
 */
import type { Jaw, PartKind } from "@dentosim/canonical";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { TriangleBvh } from "../math/bvh.js";
import { trimmedMean } from "../math/linalg.js";
import { bounds, sampleSurface, weld, type Mesh } from "../mesh/mesh.js";

export const TSM2_MAGIC = "TSM2";
export const TSM2_VERSION = 1;
const PRELUDE = 20;

export interface Tsm2PartInput {
  id: string;
  kind: PartKind;
  fdi?: number;
  fdiEstimated?: boolean;
  procedural?: boolean;
  mesh: Mesh;
}

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
  version: 1;
  units: "mm";
  coordinateSystem: "dentosim-v1";
  jaw?: Jaw;
  stage?: number;
  /** what the file holds: an arch stage or a patient scan */
  content: "stage" | "scan";
  bounds: { min: [number, number, number]; max: [number, number, number] };
  parts: Tsm2PartHeader[];
}

export interface CompressOptions {
  /** maximum simplification error (mm); 0 disables simplification */
  simplifyErrorMm: number;
  /** never simplify below this fraction of the original triangles */
  minTriangleRatio: number;
  /** measure reconstruction error (costs time) */
  measureError: boolean;
}

export const DEFAULT_COMPRESS: CompressOptions = { simplifyErrorMm: 0.03, minTriangleRatio: 0.2, measureError: true };

export interface PartStats {
  id: string;
  sourceTriangles: number;
  triangles: number;
  vertices: number;
  bytes: number;
  /** trimmed mean (75 %) of original-surface → compressed-surface distances, mm */
  errorTrimmedMeanMm?: number;
  errorMaxMm?: number;
}

let ready: Promise<void> | undefined;
export function tsm2Ready(): Promise<void> {
  ready ??= Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]).then(() => undefined);
  return ready;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const pad4 = (n: number) => (n + 3) & ~3;

/** Weld, optionally simplify, and reorder a mesh for compression. */
function prepare(mesh: Mesh, opts: CompressOptions): Mesh {
  const welded = weld(mesh);
  let indices = welded.indices;
  if (opts.simplifyErrorMm > 0 && indices.length >= 3 * 64) {
    const target = Math.max(3, Math.floor((indices.length / 3) * opts.minTriangleRatio) * 3);
    const [simplified] = MeshoptSimplifier.simplify(indices, welded.positions, 3, target, opts.simplifyErrorMm, ["ErrorAbsolute"]);
    if (simplified.length >= 3) indices = simplified;
  }
  indices = new Uint32Array(indices);
  const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, true);
  const positions = new Float32Array(unique * 3);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i];
    if (r === 0xffffffff) continue;
    positions[r * 3] = welded.positions[i * 3];
    positions[r * 3 + 1] = welded.positions[i * 3 + 1];
    positions[r * 3 + 2] = welded.positions[i * 3 + 2];
  }
  return { positions, indices };
}

function quantize(m: Mesh): { data: Uint16Array; offset: [number, number, number]; scale: [number, number, number] } {
  const b = bounds(m.positions);
  const offset = b.min.map((v) => Math.fround(v)) as [number, number, number];
  const scale = [0, 1, 2].map((k) => Math.fround((b.max[k] - b.min[k]) / 65535 || 1)) as [number, number, number];
  const n = m.positions.length / 3;
  const data = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.max(0, Math.min(65535, Math.round((m.positions[i * 3 + k] - offset[k]) / scale[k])));
  return { data, offset, scale };
}

/** Error between the source surface and its compressed reconstruction (both directions). */
export function surfaceError(original: Mesh, compressed: Mesh, samples = 1500): { trimmedMean: number; max: number } {
  const fwdBvh = new TriangleBvh(compressed.positions, compressed.indices);
  const backBvh = new TriangleBvh(original.positions, original.indices);
  const a = sampleSurface(original, samples, 31), b = sampleSurface(compressed, samples, 32);
  const d = new Float64Array(a.length / 3 + b.length / 3);
  let k = 0;
  for (let i = 0; i < a.length; i += 3) d[k++] = Math.sqrt(fwdBvh.distance2(a[i], a[i + 1], a[i + 2]));
  for (let i = 0; i < b.length; i += 3) d[k++] = Math.sqrt(backBvh.distance2(b[i], b[i + 1], b[i + 2]));
  let max = 0;
  for (const v of d) if (v > max) max = v;
  return { trimmedMean: trimmedMean(d, 0.75), max };
}

export async function encodeTsm2(
  parts: Tsm2PartInput[],
  meta: { jaw?: Jaw; stage?: number; content: "stage" | "scan" },
  opts: CompressOptions = DEFAULT_COMPRESS,
): Promise<{ bytes: Uint8Array; header: Tsm2Header; stats: PartStats[] }> {
  await tsm2Ready();
  const chunks: Uint8Array[] = [];
  let bodyLen = 0;
  const headers: Tsm2PartHeader[] = [];
  const stats: PartStats[] = [];
  const all = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
  for (const part of parts) {
    const prepared = prepare(part.mesh, opts);
    const q = quantize(prepared);
    const vcount = prepared.positions.length / 3;
    const venc = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(q.data.buffer), vcount, 8);
    const ienc = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(prepared.indices.buffer), prepared.indices.length, 4);
    const vOff = bodyLen;
    chunks.push(venc);
    bodyLen += venc.length;
    const vpad = pad4(bodyLen) - bodyLen;
    if (vpad) { chunks.push(new Uint8Array(vpad)); bodyLen += vpad; }
    const iOff = bodyLen;
    chunks.push(ienc);
    bodyLen += ienc.length;
    const ipad = pad4(bodyLen) - bodyLen;
    if (ipad) { chunks.push(new Uint8Array(ipad)); bodyLen += ipad; }
    const b = bounds(prepared.positions);
    for (let k = 0; k < 3; k++) { all.min[k] = Math.min(all.min[k], b.min[k]); all.max[k] = Math.max(all.max[k], b.max[k]); }
    headers.push({
      id: part.id,
      kind: part.kind,
      ...(part.fdi !== undefined ? { fdi: part.fdi } : {}),
      ...(part.fdiEstimated ? { fdiEstimated: true } : {}),
      ...(part.procedural ? { procedural: true } : {}),
      vertexCount: vcount,
      triangleCount: prepared.indices.length / 3,
      quantization: { bits: 16, offset: q.offset, scale: q.scale },
      vertices: { encoding: "meshopt-vertex", stride: 8, byteOffset: vOff, byteLength: venc.length },
      indices: { encoding: "meshopt-index", indexSize: 4, byteOffset: iOff, byteLength: ienc.length },
    });
    const st: PartStats = { id: part.id, sourceTriangles: part.mesh.indices.length / 3, triangles: prepared.indices.length / 3, vertices: vcount, bytes: venc.length + ienc.length };
    if (opts.measureError) {
      const decoded = { positions: dequantize(q.data, vcount, q.offset, q.scale), indices: prepared.indices };
      const e = surfaceError(part.mesh, decoded);
      st.errorTrimmedMeanMm = +e.trimmedMean.toFixed(5);
      st.errorMaxMm = +e.max.toFixed(5);
    }
    stats.push(st);
  }
  const header: Tsm2Header = {
    format: "TSM2",
    version: 1,
    units: "mm",
    coordinateSystem: "dentosim-v1",
    ...(meta.jaw ? { jaw: meta.jaw } : {}),
    ...(meta.stage !== undefined ? { stage: meta.stage } : {}),
    content: meta.content,
    bounds: parts.length ? { min: all.min.map((v) => +v.toFixed(4)) as [number, number, number], max: all.max.map((v) => +v.toFixed(4)) as [number, number, number] } : { min: [0, 0, 0], max: [0, 0, 0] },
    parts: headers,
  };
  let json = JSON.stringify(header);
  const enc = new TextEncoder();
  let hb = enc.encode(json);
  json += " ".repeat(pad4(hb.length) - hb.length);
  hb = enc.encode(json);
  const body = new Uint8Array(bodyLen);
  let o = 0;
  for (const c of chunks) { body.set(c, o); o += c.length; }
  const out = new Uint8Array(PRELUDE + hb.length + bodyLen);
  const dv = new DataView(out.buffer);
  out.set(enc.encode(TSM2_MAGIC), 0);
  dv.setUint16(4, TSM2_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, hb.length, true);
  dv.setUint32(12, bodyLen, true);
  dv.setUint32(16, crc32(body), true);
  out.set(hb, PRELUDE);
  out.set(body, PRELUDE + hb.length);
  return { bytes: out, header, stats };
}

function dequantize(q: Uint16Array, n: number, offset: number[], scale: number[]): Float32Array {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = offset[k] + q[i * 4 + k] * scale[k];
  return p;
}

export class Tsm2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Tsm2Error";
  }
}

export function readTsm2Header(bytes: Uint8Array): { header: Tsm2Header; body: Uint8Array; crcOk: boolean } {
  if (bytes.length < PRELUDE || new TextDecoder().decode(bytes.subarray(0, 4)) !== TSM2_MAGIC) throw new Tsm2Error("not a TSM2 file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== TSM2_VERSION) throw new Tsm2Error(`unsupported TSM2 version ${version}`);
  const hl = dv.getUint32(8, true), bl = dv.getUint32(12, true), crc = dv.getUint32(16, true);
  if (PRELUDE + hl + bl !== bytes.length) throw new Tsm2Error("TSM2 length mismatch (truncated file?)");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(PRELUDE, PRELUDE + hl))) as Tsm2Header;
  const body = bytes.subarray(PRELUDE + hl);
  return { header, body, crcOk: crc32(body) === crc };
}

export async function decodeTsm2(bytes: Uint8Array): Promise<{ header: Tsm2Header; parts: (Tsm2PartHeader & { mesh: Mesh })[] }> {
  await tsm2Ready();
  const { header, body, crcOk } = readTsm2Header(bytes);
  if (!crcOk) throw new Tsm2Error("TSM2 body checksum mismatch");
  const parts = header.parts.map((p) => {
    const q = new Uint8Array(p.vertexCount * 8);
    MeshoptDecoder.decodeVertexBuffer(q, p.vertexCount, 8, body.subarray(p.vertices.byteOffset, p.vertices.byteOffset + p.vertices.byteLength));
    const idx = new Uint8Array(p.triangleCount * 3 * 4);
    MeshoptDecoder.decodeIndexBuffer(idx, p.triangleCount * 3, 4, body.subarray(p.indices.byteOffset, p.indices.byteOffset + p.indices.byteLength));
    const positions = dequantize(new Uint16Array(q.buffer), p.vertexCount, p.quantization.offset, p.quantization.scale);
    return { ...p, mesh: { positions, indices: new Uint32Array(idx.buffer) } };
  });
  return { header, parts };
}
