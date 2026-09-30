import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { loadMesh, MeshParseError, writeAsciiStl, writeBinaryPly, writeBinaryStl, writeObj } from "../src/io/loaders.js";
import { IntakeError, readExportFiles, safePath } from "../src/io/input.js";
import { write3mf, writeGlb } from "../src/fixtures/catalog.js";
import { box, toothShell } from "../src/fixtures/synth.js";
import { surfaceArea, weld } from "../src/mesh/mesh.js";

const tooth = toothShell([4, 5, 3.5]);
const area = surfaceArea(tooth);

describe("mesh loaders", () => {
  it.each([
    ["binary STL", "a.stl", writeBinaryStl(tooth)],
    ["ASCII STL", "a.stl", writeAsciiStl(tooth)],
    ["OBJ", "a.obj", writeObj([{ name: "t", mesh: tooth }])],
    ["binary PLY", "a.ply", writeBinaryPly(tooth)],
    ["3MF", "a.3mf", write3mf([{ name: "t", mesh: tooth }])],
    ["GLB", "a.glb", writeGlb([{ name: "t", mesh: tooth }])],
  ])("round-trips %s", (_name, path, data) => {
    const f = loadMesh(path, data);
    expect(f.nodes).toHaveLength(1);
    const m = weld(f.nodes[0].mesh);
    expect(m.indices.length).toBe(tooth.indices.length);
    expect(surfaceArea(m)).toBeCloseTo(area, 2);
  });

  it("parses ASCII PLY", () => {
    const b = box([1, 2, 3]);
    const lines = ["ply", "format ascii 1.0", `element vertex ${b.positions.length / 3}`, "property float x", "property float y", "property float z", `element face ${b.indices.length / 3}`, "property list uchar int vertex_indices", "end_header"];
    for (let i = 0; i < b.positions.length; i += 3) lines.push(`${b.positions[i]} ${b.positions[i + 1]} ${b.positions[i + 2]}`);
    for (let i = 0; i < b.indices.length; i += 3) lines.push(`3 ${b.indices[i]} ${b.indices[i + 1]} ${b.indices[i + 2]}`);
    const m = loadMesh("b.ply", new TextEncoder().encode(lines.join("\n"))).nodes[0].mesh;
    expect(surfaceArea(m)).toBeCloseTo(2 * (1 * 2 + 2 * 3 + 1 * 3), 4);
  });

  it("keeps scene nodes separate (OBJ groups, GLB nodes, 3MF objects)", () => {
    const nodes = [{ name: "Upper_Stage_0", mesh: tooth }, { name: "Upper_Stage_1", mesh: box([1, 1, 1]) }];
    for (const [p, d] of [["s.obj", writeObj(nodes)], ["s.glb", writeGlb(nodes)], ["s.3mf", write3mf(nodes)]] as const) {
      const f = loadMesh(p, d);
      expect(f.nodes.map((n) => n.name)).toEqual(["Upper_Stage_0", "Upper_Stage_1"]);
    }
  });

  it("rejects corrupt files with a readable error", () => {
    const bad = writeBinaryStl(tooth).slice(0, 500);
    expect(() => loadMesh("x.stl", bad)).toThrow(MeshParseError);
    expect(() => loadMesh("x.obj", new TextEncoder().encode("v 0 0 0\nf 1 2 3\n"))).toThrow(/missing vertex|out of range/);
  });
});

describe("upload intake hardening", () => {
  const stl = writeBinaryStl(tooth);

  it("rejects zip-slip paths", () => {
    expect(() => safePath("../../etc/passwd")).toThrow(IntakeError);
    expect(() => safePath("/abs/file.stl")).toThrow(IntakeError);
    expect(() => safePath("C:\\x\\y.stl")).toThrow(IntakeError);
    expect(safePath("a\\b/./c.stl")).toBe("a/b/c.stl");
    const zip = zipSync({ "ok/a.stl": stl, "../evil.stl": stl });
    expect(() => readExportFiles([{ path: "u.zip", data: zip }])).toThrow(/traversal/);
  });

  it("rejects zip bombs by compression ratio", () => {
    const zeros = new Uint8Array(40 * 1024 * 1024);
    const zip = zipSync({ "bomb.stl": zeros }, { level: 9 });
    expect(() => readExportFiles([{ path: "u.zip", data: zip }])).toThrow(/compression ratio/);
  });

  it("enforces size and count limits", () => {
    const limits = { maxFiles: 2, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 21, maxCompressionRatio: 200, maxArchiveDepth: 2 };
    const files = [0, 1, 2].map((i) => ({ path: `f${i}.stl`, data: new Uint8Array([i]) }));
    expect(() => readExportFiles(files, limits)).toThrow(/more than 2 files/);
    expect(() => readExportFiles([{ path: "big.stl", data: new Uint8Array(2 << 20) }], limits)).toThrow(/exceeds/);
  });

  it("expands nested zips, drops OS junk, reports duplicates without dropping them", () => {
    const inner = zipSync({ "Upper_01.stl": stl });
    const outer = zipSync({ "case/inner.zip": inner, "case/Upper_02.stl": stl, "__MACOSX/case/._x": new Uint8Array(4), "case/.DS_Store": new Uint8Array(3) });
    const r = readExportFiles([{ path: "upload.zip", data: outer }]);
    expect(r.files.map((f) => f.path).sort()).toEqual(["upload/case/Upper_02.stl", "upload/case/inner/Upper_01.stl"]);
    expect(r.skipped).toHaveLength(2);
    expect(r.duplicates).toHaveLength(1);
  });

  it("limits archive nesting depth", () => {
    let z = zipSync({ "a.stl": stl });
    for (let i = 0; i < 4; i++) z = zipSync({ [`l${i}.zip`]: z });
    expect(() => readExportFiles([{ path: "u.zip", data: z }])).toThrow(/nested deeper/);
  });
});
