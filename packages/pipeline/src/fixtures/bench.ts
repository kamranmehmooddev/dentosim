/**
 * Load benchmark: a dense synthetic export of realistic size (default ≈ 300 MB
 * of binary STL: 2 arches × 21 stages × ~7 MB) processed end to end.
 *
 *   tsx src/fixtures/bench.ts [outDir] [--stages 20] [--lat 56] [--lon 90]
 */
import { mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeBinaryStl } from "../io/loaders.js";
import { processExport } from "../pipeline.js";
import { makeArch, scanOf, stageModel } from "./synth.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { stages: { type: "string" }, lat: { type: "string" }, lon: { type: "string" }, scans: { type: "boolean" } },
});
const root = positionals[0] ?? "/tmp/dentosim-bench";
const stages = +(values.stages ?? 20), lat = +(values.lat ?? 56), lon = +(values.lon ?? 90);
const exportDir = join(root, "export"), outDir = join(root, "package");
rmSync(root, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });

const t0 = Date.now();
let bytes = 0;
for (const jaw of ["upper", "lower"] as const) {
  const a = makeArch({ jaw, seed: jaw === "upper" ? 1 : 2, stages, attachments: true, embossedText: true, lat, lon });
  for (let k = 0; k <= stages; k++) {
    const data = writeBinaryStl(stageModel(a, k).full);
    bytes += data.length;
    writeFileSync(join(exportDir, `${jaw === "upper" ? "Maxillary" : "Mandibular"}_Stage_${String(k).padStart(2, "0")}.stl`), data);
  }
  if (values.scans) writeFileSync(join(exportDir, `${jaw}_scan.stl`), writeBinaryStl(scanOf(a, 3)));
}
console.log(`generated ${readdirSync(exportDir).length} files, ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const t1 = Date.now();
const r = await processExport(exportDir, outDir, {
  onProgress: (p) => process.stderr.write(`\r[${String(p.percent).padStart(3)}%] ${p.message.padEnd(50)}`),
});
process.stderr.write("\n");
const secs = (Date.now() - t1) / 1000;
if (r.status !== "ready") throw new Error("bench export needed mapping");
const pkgBytes = readdirSync(outDir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .reduce((s, d) => s + statSync(join(d.parentPath, d.name)).size, 0);
console.log(JSON.stringify({
  sourceMB: +(bytes / 1e6).toFixed(1),
  packageMB: +(pkgBytes / 1e6).toFixed(2),
  ratio: r.metadata.compression.ratio,
  errorTrimmedMeanMm: r.metadata.compression.errorTrimmedMeanMm,
  errorMaxMm: r.metadata.compression.errorMaxMm,
  triangles: `${r.metadata.compression.sourceTriangles} → ${r.metadata.compression.triangles}`,
  seconds: +secs.toFixed(1),
  peakRssMB: +(process.resourceUsage().maxRSS / 1024).toFixed(0),
  timingsMs: r.timingsMs,
}, null, 2));
