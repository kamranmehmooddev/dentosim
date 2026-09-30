/**
 * Runs the pipeline for one revision inside a separate Node process started by
 * the worker with a heap limit and a wall-clock timeout (see processing.ts).
 * Communicates by JSON lines on stdout: {"progress": …} and a final {"result": …}.
 *
 *   node --max-old-space-size=N sandbox-runner.js '<json args>'
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ImportContext, PipelineError, mappingUnits, processExport, readExportPath, renderPng, COLORS,
  type Mapping, type MappingTemplate,
} from "@dentosim/pipeline";

interface Args {
  inputDir: string;
  outDir: string;
  templates: MappingTemplate[];
  manualMapping?: Mapping;
}

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

async function main() {
  const args = JSON.parse(process.argv[2]) as Args;
  const pkgDir = join(args.outDir, "package");
  try {
    const intake = readExportPath(args.inputDir);
    const r = await processExport(intake, pkgDir, {
      templates: args.templates,
      ...(args.manualMapping ? { manualMapping: args.manualMapping } : {}),
      onProgress: (p) => emit({ progress: p }),
    });
    if (r.status === "needs-mapping") {
      // small 3D thumbnails for the mapping screen, one per file / scene node
      const ctx = new ImportContext(intake.files);
      const thumbDir = join(args.outDir, "thumbs");
      mkdirSync(thumbDir, { recursive: true });
      const units = mappingUnits(ctx);
      const thumbs: Record<string, string> = {};
      units.slice(0, 400).forEach((u, i) => {
        try {
          const loaded = ctx.mesh(u.path);
          const nodes = u.node !== undefined ? loaded.nodes.filter((n) => n.name === u.node) : loaded.nodes;
          const png = renderPng(nodes.map((n) => ({ mesh: n.mesh, color: COLORS.arch })), { width: 160, height: 120, view: "auto", background: [245, 245, 244, 255] });
          const name = `${String(i).padStart(4, "0")}.png`;
          writeFileSync(join(thumbDir, name), png);
          thumbs[u.node !== undefined ? `${u.path}#${u.node}` : u.path] = name;
        } catch {
          /* unreadable files have no thumbnail */
        }
      });
      emit({ result: { status: "needs-mapping", proposal: r.proposal, reasons: r.reasons, detection: r.detection, warnings: r.warnings, thumbs } });
      return;
    }
    emit({
      result: {
        status: "ready",
        adapter: r.adapter,
        vendor: r.case.source.vendor,
        detection: r.detection,
        warnings: r.warnings,
        metadata: {
          stagesPerJaw: r.metadata.stagesPerJaw,
          stageCount: r.metadata.stageCount,
          compression: r.metadata.compression,
        },
        registration: r.case.registration,
        segmentation: r.case.segmentation,
        normalization: r.case.normalization ? { sourceUnits: r.case.normalization.sourceUnits, interArch: r.case.normalization.interArch } : undefined,
        mappingApplied: r.case.source.mappingApplied,
        timingsMs: r.timingsMs,
      },
    });
  } catch (e) {
    if (e instanceof PipelineError) emit({ error: { code: e.code, message: e.userMessage } });
    else emit({ error: { code: "INTERNAL", message: "Unexpected processing error.", detail: (e as Error).stack?.split("\n").slice(0, 4).join(" | ") } });
    process.exitCode = 2;
  }
}

void main();
