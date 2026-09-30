/**
 * Synthetic generic-format fixtures. Each one exercises an export *style* the
 * generic adapter must handle; none imitates a specific vendor's format
 * (vendor fixtures must be real, anonymised exports — see fixtures/README.md).
 */
import { zipSync } from "fflate";
import { multiply4, rigidFromEuler, scale4, translation4, type Mat4 } from "../math/linalg.js";
import { transformMesh, type Mesh } from "../mesh/mesh.js";
import { writeAsciiStl, writeBinaryPly, writeBinaryStl, writeObj } from "../io/loaders.js";
import { makeArch, scanOf, stageModel, type SynthArch } from "./synth.js";

export interface FixtureFile {
  path: string;
  data: Uint8Array;
}

export interface FixtureDef {
  name: string;
  description: string;
  files(): FixtureFile[];
}

const deg = (d: number) => (d * Math.PI) / 180;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function arches(seed: number, upperStages: number, lowerStages: number, extra: Partial<Parameters<typeof makeArch>[0]> = {}) {
  return {
    upper: makeArch({ jaw: "upper", seed, stages: upperStages, attachments: true, embossedText: true, ...extra }),
    lower: makeArch({ jaw: "lower", seed: seed + 1, stages: lowerStages, attachments: true, embossedText: true, ...extra }),
  };
}

const moved = (m: Mesh, T: Mat4): Mesh => transformMesh(m, T);

/** 3MF writer (one object per mesh) for fixtures. */
export function write3mf(nodes: { name: string; mesh: Mesh }[]): Uint8Array {
  const objs = nodes
    .map((n, i) => {
      const v: string[] = [];
      for (let k = 0; k < n.mesh.positions.length; k += 3)
        v.push(`<vertex x="${n.mesh.positions[k]}" y="${n.mesh.positions[k + 1]}" z="${n.mesh.positions[k + 2]}"/>`);
      const t: string[] = [];
      for (let k = 0; k < n.mesh.indices.length; k += 3)
        t.push(`<triangle v1="${n.mesh.indices[k]}" v2="${n.mesh.indices[k + 1]}" v3="${n.mesh.indices[k + 2]}"/>`);
      return `<object id="${i + 1}" name="${n.name}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`;
    })
    .join("");
  const items = nodes.map((_, i) => `<item objectid="${i + 1}"/>`).join("");
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objs}</resources><build>${items}</build></model>`;
  const enc = new TextEncoder();
  return zipSync({
    "[Content_Types].xml": enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    "3D/3dmodel.model": enc.encode(model),
  });
}

/** Minimal GLB writer: one node per mesh (positions + uint32 indices). */
export function writeGlb(nodes: { name: string; mesh: Mesh }[]): Uint8Array {
  const bufs: Uint8Array[] = [];
  let off = 0;
  const bufferViews: object[] = [], accessors: object[] = [], meshes: object[] = [], gnodes: object[] = [];
  for (const [i, n] of nodes.entries()) {
    const p = new Uint8Array(n.mesh.positions.buffer.slice(n.mesh.positions.byteOffset, n.mesh.positions.byteOffset + n.mesh.positions.byteLength));
    const ix = new Uint8Array(n.mesh.indices.buffer.slice(n.mesh.indices.byteOffset, n.mesh.indices.byteOffset + n.mesh.indices.byteLength));
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n.mesh.positions.length; k += 3)
      for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], n.mesh.positions[k + c]); mx[c] = Math.max(mx[c], n.mesh.positions[k + c]); }
    bufferViews.push({ buffer: 0, byteOffset: off, byteLength: p.length });
    bufs.push(p); off += p.length;
    bufferViews.push({ buffer: 0, byteOffset: off, byteLength: ix.length });
    bufs.push(ix); off += ix.length;
    accessors.push({ bufferView: i * 2, componentType: 5126, count: n.mesh.positions.length / 3, type: "VEC3", min: mn, max: mx });
    accessors.push({ bufferView: i * 2 + 1, componentType: 5125, count: n.mesh.indices.length, type: "SCALAR" });
    meshes.push({ name: n.name, primitives: [{ attributes: { POSITION: i * 2 }, indices: i * 2 + 1 }] });
    gnodes.push({ name: n.name, mesh: i });
  }
  const gltf = { asset: { version: "2.0", generator: "DentoSim fixtures" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes: gnodes, meshes, accessors, bufferViews, buffers: [{ byteLength: off }] };
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const jpad = (4 - (json.length % 4)) % 4;
  json = new Uint8Array([...json, ...new Array(jpad).fill(0x20)]);
  const bin = new Uint8Array(off + ((4 - (off % 4)) % 4));
  let o = 0;
  for (const b of bufs) { bin.set(b, o); o += b.length; }
  const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
  dv.setUint32(20 + json.length, bin.length, true); dv.setUint32(24 + json.length, 0x004e4942, true); out.set(bin, 28 + json.length);
  return out;
}

function stageFiles(a: SynthArch, name: (k: number) => string, T: Mat4 = translation4([0, 0, 0]), writer: (m: Mesh) => Uint8Array = (m) => writeBinaryStl(m)): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (let k = 0; k <= a.stages; k++) out.push({ path: name(k), data: writer(moved(stageModel(a, k).full, T)) });
  return out;
}

export const FIXTURES: FixtureDef[] = [
  {
    name: "generic-maxmand-folders",
    description: "Numbered binary STL per stage in Maxillary/ and Mandibular/ folders (mm). Attachments + embossed text; lower arch finishes 2 stages earlier.",
    files() {
      const { upper, lower } = arches(101, 8, 6);
      return [
        ...stageFiles(upper, (k) => `Case 10482/Maxillary/Maxillary_Stage_${pad(k)}.stl`),
        ...stageFiles(lower, (k) => `Case 10482/Mandibular/Mandibular_Stage_${pad(k)}.stl`),
        { path: "Case 10482/report.pdf", data: new TextEncoder().encode("%PDF-1.4 placeholder") },
        { path: "__MACOSX/Case 10482/._Maxillary_Stage_00.stl", data: new Uint8Array([0, 5, 22, 7]) },
      ];
    },
  },
  {
    name: "generic-inch-ascii-tilted",
    description: "ASCII STL in inches, '03_of_10' numbering with an 'initial' model, both arches tilted 25°/−15° for 3D printing (relationship kept).",
    files() {
      const { upper, lower } = arches(202, 10, 10, { embossedText: false });
      const T = multiply4(scale4(1 / 25.4), rigidFromEuler(deg(25), deg(-15), deg(8), [40, -12, 90]));
      return [
        ...stageFiles(upper, (k) => (k === 0 ? "export/Upper initial.stl" : `export/Upper ${pad(k)}_of_10.stl`), T, (m) => writeAsciiStl(m)),
        ...stageFiles(lower, (k) => (k === 0 ? "export/Lower initial.stl" : `export/Lower ${pad(k)}_of_10.stl`), T, (m) => writeAsciiStl(m)),
      ];
    },
  },
  {
    name: "generic-with-scans",
    description: "UJ/LJ step files with the lower arch mis-positioned in the export (wrong bite) plus upper/lower PLY patient scans in a scanner frame; registration must recover the true bite.",
    files() {
      const { upper, lower } = arches(303, 6, 6);
      const scanFrame = rigidFromEuler(deg(-80), deg(12), deg(170), [-3, 55, 12]);
      const exportUpper = rigidFromEuler(deg(4), deg(-6), 0, [2, 1, -1]);
      const wrongBite = multiply4(exportUpper, rigidFromEuler(deg(3), deg(-2), deg(2), [1.5, -1.2, 2.0]));
      return [
        ...stageFiles(upper, (k) => `plan/UJ_step${k}.stl`, exportUpper),
        ...stageFiles(lower, (k) => `plan/LJ_step${k}.stl`, wrongBite),
        { path: "scans/upper_scan.ply", data: writeBinaryPly(moved(scanOf(upper, 7), scanFrame)) },
        { path: "scans/lower_scan.ply", data: writeBinaryPly(moved(scanOf(lower, 8), scanFrame)) },
      ];
    },
  },
  {
    name: "generic-unlabeled-numbered",
    description: "Two folders A/ and B/ of numbered models with no jaw words; the upper arch is recognised by its palate. Includes a byte-identical duplicate file.",
    files() {
      const { upper, lower } = arches(404, 5, 5, { attachments: false });
      const files = [...stageFiles(upper, (k) => `A/${pad(k)}.stl`), ...stageFiles(lower, (k) => `B/${pad(k)}.stl`)];
      files.push({ path: "A/copy/05.stl", data: files[5].data });
      return files;
    },
  },
  {
    name: "generic-scene-glb",
    description: "A single GLB scene with one node per arch per stage (\"Upper_Stage_3\"), in a y-down frame.",
    files() {
      const { upper, lower } = arches(505, 4, 4, { embossedText: false });
      const T = rigidFromEuler(deg(180), 0, 0);
      const nodes: { name: string; mesh: Mesh }[] = [];
      for (let k = 0; k <= 4; k++) {
        nodes.push({ name: `Upper_Stage_${k}`, mesh: moved(stageModel(upper, k).full, T) });
        nodes.push({ name: `Lower_Stage_${k}`, mesh: moved(stageModel(lower, k).full, T) });
      }
      return [{ path: "treatment.glb", data: writeGlb(nodes) }];
    },
  },
  {
    name: "generic-per-tooth-files",
    description: "Stage folders with one file per tooth (tooth_11.stl …) plus a gingiva model; OBJ for teeth, 3MF for gingiva. Upper arch only.",
    files() {
      const a = makeArch({ jaw: "upper", seed: 606, stages: 3 });
      const out: FixtureFile[] = [];
      for (let k = 0; k <= 3; k++) {
        const s = stageModel(a, k);
        for (const t of s.teeth) out.push({ path: `Setup ${k}/tooth_${t.fdi}.obj`, data: writeObj([{ name: `tooth_${t.fdi}`, mesh: t.mesh }]) });
        out.push({ path: `Setup ${k}/gingiva.3mf`, data: write3mf([{ name: "gingiva", mesh: s.gums }]) });
      }
      return out;
    },
  },
  {
    name: "generic-print-layout",
    description: "Both arches exported base-down side by side for printing (no bite relationship), fused last molars in quadrants 1 and 4.",
    files() {
      const { upper, lower } = arches(707, 3, 3, { fusedMolar: true, embossedText: false });
      // upper flipped so its base is down, both placed next to each other on the build plate
      const up = rigidFromEuler(deg(180), 0, deg(0), [-40, 16, 0]);
      const lo = translation4([40, 16, 0]);
      return [
        ...stageFiles(upper, (k) => `print/upper_${pad(k)}.stl`, up),
        ...stageFiles(lower, (k) => `print/lower_${pad(k)}.stl`, lo),
      ];
    },
  },
  {
    name: "generic-single-shell",
    description: "Lower arch only, teeth and gums fused into one surface (unsegmentable), numbered 'Step N' files starting at 1.",
    files() {
      const a = makeArch({ jaw: "lower", seed: 808, stages: 4, singleShell: true });
      return stageFiles(a, (k) => `Lower Step ${k + 1}.stl`);
    },
  },
  {
    name: "unknown-needs-mapping",
    description: "Files with meaningless names: the pipeline must stop at the mapping screen with a proposal.",
    files() {
      const { upper, lower } = arches(909, 2, 2, { attachments: false });
      const names = ["kx7", "qa2", "zz9"];
      return [
        ...stageFiles(upper, (k) => `${names[k]}-a.stl`),
        ...stageFiles(lower, (k) => `${names[k]}-b.stl`),
        { path: "readme.txt", data: new TextEncoder().encode("exported") },
      ];
    },
  },
  {
    name: "unknown-needs-mapping-repeat",
    description: "A second export from the same unknown software (same naming layout, different case): the saved template from unknown-needs-mapping must map it automatically.",
    files() {
      const { upper, lower } = arches(919, 2, 2, { attachments: false });
      const names = ["kx4", "qa8", "zz1"];
      return [...stageFiles(upper, (k) => `${names[k]}-a.stl`), ...stageFiles(lower, (k) => `${names[k]}-b.stl`)];
    },
  },
];

/** Fixtures whose export is a zip archive rather than a folder. */
export const ZIPPED_FIXTURES = new Set(["generic-maxmand-folders"]);

export function fixtureZip(files: FixtureFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.path, f.data])), { level: 6 });
}

