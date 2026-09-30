/**
 * Headless mesh loaders: STL (binary + ASCII), OBJ, PLY (ascii / binary LE / BE),
 * 3MF and glTF 2.0 (.gltf with embedded/sibling buffers, .glb).
 *
 * Every loader returns one or more named meshes ("nodes"). Scene formats
 * (OBJ groups, 3MF objects, glTF nodes) keep their node names so adapters can
 * find stages inside a single file (export style 3).
 * Materials/textures are ignored — the viewer applies its own lab materials.
 */
import { unzipSync, strFromU8 } from "fflate";
import type { Mesh } from "../mesh/mesh.js";
import { identity4, multiply4, transformPositions, type Mat4 } from "../math/linalg.js";

export interface LoadedNode {
  name: string;
  mesh: Mesh;
}

export interface LoadedFile {
  format: MeshFormat;
  nodes: LoadedNode[];
}

export type MeshFormat = "stl" | "obj" | "ply" | "3mf" | "gltf" | "glb";

export class MeshParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshParseError";
  }
}

export const MESH_EXTENSIONS: Record<string, MeshFormat> = {
  ".stl": "stl",
  ".obj": "obj",
  ".ply": "ply",
  ".3mf": "3mf",
  ".gltf": "gltf",
  ".glb": "glb",
};

export function meshFormatOf(path: string): MeshFormat | undefined {
  const m = /\.[^./\\]+$/.exec(path.toLowerCase());
  return m ? MESH_EXTENSIONS[m[0]] : undefined;
}

/** Resolve sibling files (glTF .bin buffers). */
export type SiblingResolver = (relativeUri: string) => Uint8Array | undefined;

export function loadMesh(path: string, data: Uint8Array, siblings?: SiblingResolver): LoadedFile {
  const format = meshFormatOf(path);
  if (!format) throw new MeshParseError(`Unsupported mesh extension: ${path}`);
  let nodes: LoadedNode[];
  switch (format) {
    case "stl": nodes = [{ name: "", mesh: parseStl(data) }]; break;
    case "obj": nodes = parseObj(data); break;
    case "ply": nodes = [{ name: "", mesh: parsePly(data) }]; break;
    case "3mf": nodes = parse3mf(data); break;
    case "gltf": nodes = parseGltf(JSON.parse(strFromU8(data)), undefined, siblings); break;
    case "glb": nodes = parseGlb(data, siblings); break;
  }
  nodes = nodes.filter((n) => n.mesh.indices.length > 0);
  if (nodes.length === 0) throw new MeshParseError(`${path}: file contains no triangles`);
  for (const n of nodes) validateMesh(n.mesh, path);
  return { format, nodes };
}

function validateMesh(m: Mesh, path: string): void {
  const nv = m.positions.length / 3;
  for (let i = 0; i < m.positions.length; i++)
    if (!Number.isFinite(m.positions[i])) throw new MeshParseError(`${path}: non-finite vertex coordinate`);
  for (let i = 0; i < m.indices.length; i++)
    if (m.indices[i] >= nv) throw new MeshParseError(`${path}: triangle index out of range`);
}

// ─────────────────────────────── STL ───────────────────────────────

export function parseStl(data: Uint8Array): Mesh {
  if (data.length >= 84) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === data.length) return parseBinaryStl(dv, n);
  }
  const head = strFromU8(data.subarray(0, Math.min(data.length, 512)), true).trimStart();
  if (head.startsWith("solid")) return parseAsciiStl(data);
  throw new MeshParseError("STL is neither valid binary (size mismatch) nor ASCII");
}

function parseBinaryStl(dv: DataView, n: number): Mesh {
  const positions = new Float32Array(n * 9);
  const indices = new Uint32Array(n * 3);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12; // skip facet normal
    for (let k = 0; k < 9; k++) {
      positions[t * 9 + k] = dv.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices };
}

function parseAsciiStl(data: Uint8Array): Mesh {
  const text = strFromU8(data, true);
  const out: number[] = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (out.length % 9 !== 0) throw new MeshParseError("ASCII STL: vertex count is not a multiple of 3");
  const positions = Float32Array.from(out);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

// ─────────────────────────────── OBJ ───────────────────────────────

export function parseObj(data: Uint8Array): LoadedNode[] {
  const text = strFromU8(data, true);
  const verts: number[] = [];
  const groups: { name: string; faces: number[] }[] = [];
  let current = { name: "", faces: [] as number[] };
  groups.push(current);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      verts.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith("f ")) {
      const nv = verts.length / 3;
      const idx = line
        .split(/\s+/)
        .slice(1)
        .map((tok) => {
          const i = parseInt(tok.split("/")[0], 10);
          return i < 0 ? nv + i : i - 1;
        });
      for (let k = 1; k + 1 < idx.length; k++) current.faces.push(idx[0], idx[k], idx[k + 1]);
    } else if (line.startsWith("o ") || line.startsWith("g ")) {
      current = { name: line.slice(2).trim(), faces: [] };
      groups.push(current);
    }
  }
  const all = Float32Array.from(verts);
  return groups
    .filter((g) => g.faces.length > 0)
    .map((g) => ({ name: g.name, mesh: compact(all, g.faces) }));
}

/** Build a compact mesh from shared positions and a face list. */
function compact(all: Float32Array, faces: number[]): Mesh {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i++) {
    let id = remap.get(faces[i]);
    if (id === undefined) {
      id = pos.length / 3;
      remap.set(faces[i], id);
      const j = faces[i] * 3;
      if (j + 2 >= all.length || faces[i] < 0) throw new MeshParseError("face references a missing vertex");
      pos.push(all[j], all[j + 1], all[j + 2]);
    }
    idx[i] = id;
  }
  return { positions: Float32Array.from(pos), indices: idx };
}

// ─────────────────────────────── PLY ───────────────────────────────

interface PlyProp { name: string; type: string; listCount?: string; listItem?: string }
interface PlyElement { name: string; count: number; props: PlyProp[] }

const PLY_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

export function parsePly(data: Uint8Array): Mesh {
  // header is ASCII and ends with "end_header\n"
  const headEnd = findSeq(data, "end_header");
  if (headEnd < 0) throw new MeshParseError("PLY: missing end_header");
  let bodyStart = headEnd + "end_header".length;
  if (data[bodyStart] === 13) bodyStart++;
  if (data[bodyStart] === 10) bodyStart++;
  const header = strFromU8(data.subarray(0, headEnd), true).split(/\r?\n/);
  if (header[0].trim() !== "ply") throw new MeshParseError("PLY: bad magic");
  let format = "ascii";
  const elements: PlyElement[] = [];
  for (const l of header) {
    const p = l.trim().split(/\s+/);
    if (p[0] === "format") format = p[1];
    else if (p[0] === "element") elements.push({ name: p[1], count: parseInt(p[2], 10), props: [] });
    else if (p[0] === "property") {
      const el = elements[elements.length - 1];
      if (p[1] === "list") el.props.push({ name: p[4], type: "list", listCount: p[2], listItem: p[3] });
      else el.props.push({ name: p[2], type: p[1] });
    }
  }
  const pos: number[] = [];
  const faces: number[] = [];
  if (format === "ascii") {
    const tokens = strFromU8(data.subarray(bodyStart), true).trim().split(/\s+/);
    let t = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        const rec: Record<string, number | number[]> = {};
        for (const pr of el.props) {
          if (pr.type === "list") {
            const c = +tokens[t++];
            const arr: number[] = [];
            for (let k = 0; k < c; k++) arr.push(+tokens[t++]);
            rec[pr.name] = arr;
          } else rec[pr.name] = +tokens[t++];
        }
        collectPly(el, rec, pos, faces);
      }
    }
  } else {
    const le = format === "binary_little_endian";
    if (!le && format !== "binary_big_endian") throw new MeshParseError(`PLY: unsupported format ${format}`);
    const dv = new DataView(data.buffer, data.byteOffset + bodyStart, data.byteLength - bodyStart);
    let o = 0;
    const read = (type: string): number => {
      const size = PLY_SIZES[type];
      if (!size) throw new MeshParseError(`PLY: unknown type ${type}`);
      if (o + size > dv.byteLength) throw new MeshParseError("PLY: truncated body");
      let v: number;
      switch (type) {
        case "char": case "int8": v = dv.getInt8(o); break;
        case "uchar": case "uint8": v = dv.getUint8(o); break;
        case "short": case "int16": v = dv.getInt16(o, le); break;
        case "ushort": case "uint16": v = dv.getUint16(o, le); break;
        case "int": case "int32": v = dv.getInt32(o, le); break;
        case "uint": case "uint32": v = dv.getUint32(o, le); break;
        case "float": case "float32": v = dv.getFloat32(o, le); break;
        default: v = dv.getFloat64(o, le);
      }
      o += size;
      return v;
    };
    for (const el of elements)
      for (let i = 0; i < el.count; i++) {
        const rec: Record<string, number | number[]> = {};
        for (const pr of el.props) {
          if (pr.type === "list") {
            const c = read(pr.listCount!);
            const arr: number[] = [];
            for (let k = 0; k < c; k++) arr.push(read(pr.listItem!));
            rec[pr.name] = arr;
          } else rec[pr.name] = read(pr.type);
        }
        collectPly(el, rec, pos, faces);
      }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(faces) };
}

function collectPly(el: PlyElement, rec: Record<string, number | number[]>, pos: number[], faces: number[]): void {
  if (el.name === "vertex") pos.push(rec.x as number, rec.y as number, rec.z as number);
  else if (el.name === "face") {
    const f = (rec.vertex_indices ?? rec.vertex_index) as number[] | undefined;
    if (f) for (let k = 1; k + 1 < f.length; k++) faces.push(f[0], f[k], f[k + 1]);
  }
}

function findSeq(data: Uint8Array, s: string): number {
  const max = Math.min(data.length, 1 << 16);
  outer: for (let i = 0; i + s.length <= max; i++) {
    for (let k = 0; k < s.length; k++) if (data[i + k] !== s.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

// ─────────────────────────────── 3MF ───────────────────────────────

export function parse3mf(data: Uint8Array): LoadedNode[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (f) => f.name.toLowerCase().endsWith(".model") && f.originalSize < 1 << 30 });
  } catch (e) {
    throw new MeshParseError(`3MF: not a valid zip package (${(e as Error).message})`);
  }
  const nodes: LoadedNode[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    const xml = strFromU8(bytes, true);
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let om: RegExpExecArray | null;
    const objects = new Map<string, LoadedNode>();
    while ((om = objRe.exec(xml))) {
      const attrs = om[1];
      const id = /\bid="([^"]*)"/.exec(attrs)?.[1] ?? String(objects.size);
      const oname = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? `object-${id}`;
      const body = om[2];
      const pos: number[] = [];
      const vRe = /<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g;
      let vm: RegExpExecArray | null;
      while ((vm = vRe.exec(body))) pos.push(+vm[1], +vm[2], +vm[3]);
      const idx: number[] = [];
      const tRe = /<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(body))) idx.push(+tm[1], +tm[2], +tm[3]);
      if (idx.length) objects.set(id, { name: oname, mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) } });
    }
    // apply build-item transforms when present
    const itemRe = /<item\b([^>]*)\/?>/g;
    let im: RegExpExecArray | null;
    const used = new Set<string>();
    while ((im = itemRe.exec(xml))) {
      const oid = /\bobjectid="([^"]*)"/.exec(im[1])?.[1];
      const node = oid ? objects.get(oid) : undefined;
      if (!node) continue;
      used.add(oid!);
      const tr = /\btransform="([^"]*)"/.exec(im[1])?.[1];
      let mesh = node.mesh;
      if (tr) {
        const v = tr.trim().split(/\s+/).map(Number);
        if (v.length === 12) {
          // 3MF: 4×3 row-major, row vector convention (p' = p·M)
          const m: Mat4 = [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
          mesh = { positions: transformPositions(m, mesh.positions), indices: mesh.indices };
        }
      }
      nodes.push({ name: node.name, mesh });
    }
    for (const [id, node] of objects) if (!used.has(id)) nodes.push(node);
    void name;
  }
  return nodes;
}

// ─────────────────────────────── glTF ──────────────────────────────

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  extensionsRequired?: string[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGlb(data: Uint8Array, siblings?: SiblingResolver): LoadedNode[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new MeshParseError("GLB: bad magic");
  let o = 12;
  let json: Gltf | undefined;
  let bin: Uint8Array | undefined;
  while (o + 8 <= data.length) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    const chunk = data.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(strFromU8(chunk));
    else if (type === 0x004e4942) bin = chunk;
    o += 8 + len;
  }
  if (!json) throw new MeshParseError("GLB: missing JSON chunk");
  return parseGltf(json, bin, siblings);
}

export function parseGltf(gltf: Gltf, glbBin?: Uint8Array, siblings?: SiblingResolver): LoadedNode[] {
  const unsupported = (gltf.extensionsRequired ?? []).filter((e) => e !== "KHR_materials_unlit" && e !== "KHR_texture_transform");
  if (unsupported.length) throw new MeshParseError(`glTF: required extension not supported: ${unsupported.join(", ")}`);
  const buffers = (gltf.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i === 0 && glbBin) return glbBin;
      throw new MeshParseError("glTF: buffer without uri");
    }
    if (b.uri.startsWith("data:")) {
      const b64 = b.uri.slice(b.uri.indexOf(",") + 1);
      return new Uint8Array(Buffer.from(b64, "base64"));
    }
    const s = siblings?.(decodeURIComponent(b.uri));
    if (!s) throw new MeshParseError(`glTF: missing buffer file ${b.uri}`);
    return s;
  });
  const readAccessor = (i: number): Float32Array | Uint32Array => {
    const a = gltf.accessors?.[i];
    if (!a || a.bufferView === undefined) throw new MeshParseError("glTF: bad accessor");
    const bv = gltf.bufferViews![a.bufferView];
    const buf = buffers[bv.buffer];
    const comps = COMPONENTS[a.type];
    const csize = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 || a.componentType === 5122 ? 2 : 1;
    const stride = bv.byteStride ?? comps * csize;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = a.componentType === 5126 ? new Float32Array(a.count * comps) : new Uint32Array(a.count * comps);
    for (let e = 0; e < a.count; e++)
      for (let c = 0; c < comps; c++) {
        const off = base + e * stride + c * csize;
        let v: number;
        switch (a.componentType) {
          case 5126: v = dv.getFloat32(off, true); break;
          case 5125: v = dv.getUint32(off, true); break;
          case 5123: v = dv.getUint16(off, true); break;
          case 5121: v = dv.getUint8(off); break;
          default: throw new MeshParseError(`glTF: unsupported component type ${a.componentType}`);
        }
        out[e * comps + c] = v;
      }
    return out;
  };
  const nodes: LoadedNode[] = [];
  const localMatrix = (n: NonNullable<Gltf["nodes"]>[number]): Mat4 => {
    if (n.matrix) return n.matrix.slice();
    const [tx, ty, tz] = n.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale ?? [1, 1, 1];
    const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    return [
      (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
      2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
      2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
      tx, ty, tz, 1,
    ];
  };
  const visit = (ni: number, parent: Mat4, path: string, depth: number) => {
    if (depth > 64) throw new MeshParseError("glTF: node hierarchy too deep");
    const n = gltf.nodes![ni];
    const world = multiply4(parent, localMatrix(n));
    const name = n.name ?? (n.mesh !== undefined ? gltf.meshes?.[n.mesh]?.name : undefined) ?? `node-${ni}`;
    const full = path ? `${path}/${name}` : name;
    if (n.mesh !== undefined) {
      const parts: Mesh[] = [];
      for (const prim of gltf.meshes![n.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue; // triangles only
        const pos = readAccessor(prim.attributes.POSITION) as Float32Array;
        let idx: Uint32Array;
        if (prim.indices !== undefined) idx = Uint32Array.from(readAccessor(prim.indices));
        else {
          idx = new Uint32Array(pos.length / 3);
          for (let i = 0; i < idx.length; i++) idx[i] = i;
        }
        parts.push({ positions: transformPositions(world, pos), indices: idx });
      }
      if (parts.length) nodes.push({ name: full, mesh: mergeParts(parts) });
    }
    for (const c of n.children ?? []) visit(c, world, full, depth + 1);
  };
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? (gltf.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, identity4(), "", 0);
  return nodes;
}

function mergeParts(parts: Mesh[]): Mesh {
  if (parts.length === 1) return parts[0];
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.positions.length; ni += p.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo / 3;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return { positions, indices };
}

// ─────────────────────────────── writers (fixtures, debug) ───────────────────────────────

export function writeBinaryStl(m: Mesh, header = "DentoSim"): Uint8Array {
  const n = m.indices.length / 3;
  const out = new Uint8Array(84 + n * 50);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < Math.min(80, header.length); i++) out[i] = header.charCodeAt(i) & 0x7f;
  dv.setUint32(80, n, true);
  let o = 84;
  const p = m.positions;
  for (let t = 0; t < n; t++) {
    const a = m.indices[t * 3] * 3, b = m.indices[t * 3 + 1] * 3, c = m.indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, p[v], true); dv.setFloat32(o + 4, p[v + 1], true); dv.setFloat32(o + 8, p[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return out;
}

export function writeAsciiStl(m: Mesh, name = "dentosim"): Uint8Array {
  const lines = [`solid ${name}`];
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (let k = 0; k < 3; k++) {
      const v = m.indices[t + k] * 3;
      lines.push(`      vertex ${p[v].toExponential(6)} ${p[v + 1].toExponential(6)} ${p[v + 2].toExponential(6)}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

export function writeObj(nodes: LoadedNode[]): Uint8Array {
  const lines: string[] = ["# DentoSim"];
  let base = 1;
  for (const n of nodes) {
    lines.push(`o ${n.name}`);
    const p = n.mesh.positions;
    for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i]} ${p[i + 1]} ${p[i + 2]}`);
    for (let t = 0; t < n.mesh.indices.length; t += 3)
      lines.push(`f ${n.mesh.indices[t] + base} ${n.mesh.indices[t + 1] + base} ${n.mesh.indices[t + 2] + base}`);
    base += p.length / 3;
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

export function writeBinaryPly(m: Mesh): Uint8Array {
  const nv = m.positions.length / 3, nf = m.indices.length / 3;
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\nelement face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`;
  const hb = new TextEncoder().encode(header);
  const out = new Uint8Array(hb.length + nv * 12 + nf * 13);
  out.set(hb);
  const dv = new DataView(out.buffer);
  let o = hb.length;
  for (let i = 0; i < nv * 3; i++, o += 4) dv.setFloat32(o, m.positions[i], true);
  for (let t = 0; t < nf; t++) {
    dv.setUint8(o, 3); o++;
    for (let k = 0; k < 3; k++, o += 4) dv.setInt32(o, m.indices[t * 3 + k], true);
  }
  return out;
}
