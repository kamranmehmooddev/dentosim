#!/usr/bin/env node
/**
 * DentoSim pipeline CLI.
 *
 *   dentosim <export> <outDir> [--adapter name] [--template t.json]… [--mapping m.json] [--overwrite] [--json]
 *   dentosim detect <export> [--template t.json]… [--json]
 *   dentosim template <mapping.json> --id ID --name NAME [--software S] [--out template.json]
 *   dentosim inspect <packageDir>
 *   dentosim selfcheck [--fixtures dir] [--work dir] [--only a,b]
 *   dentosim fixtures [--fixtures dir] [--force]
 *
 * <export> may be a folder, a .zip (nested zips allowed), .7z/.rar (with 7-Zip installed) or one model file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ImportContext } from "./adapters/context.js";
import { detect, builtInAdapters } from "./adapters/registry.js";
import { proposeMapping } from "./adapters/generic.js";
import { templateAdapter, templateFromMapping, type MappingTemplate } from "./adapters/template.js";
import type { Mapping } from "./adapters/types.js";
import { readExportPath } from "./io/input.js";
import { processExport, PipelineError } from "./pipeline.js";
import { generateFixtures, runSelfCheck } from "./selfcheck.js";
import { decodeTsm2 } from "./tsm2/tsm2.js";
import type { PackageMetadata } from "./package/package.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(here, "../../../fixtures");

const USAGE = `DentoSim pipeline

  dentosim <export> <outDir> [--adapter name] [--template t.json]... [--mapping m.json] [--overwrite] [--json]
  dentosim detect <export> [--template t.json]... [--json]
  dentosim template <mapping.json> --id ID --name NAME [--software S] [--out template.json]
  dentosim inspect <packageDir>
  dentosim selfcheck [--fixtures dir] [--work dir] [--only a,b]
  dentosim fixtures [--fixtures dir] [--force]`;

function loadTemplates(paths: string[] | undefined): MappingTemplate[] {
  return (paths ?? []).map((p) => JSON.parse(readFileSync(p, "utf8")) as MappingTemplate);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      adapter: { type: "string" },
      template: { type: "string", multiple: true },
      mapping: { type: "string" },
      overwrite: { type: "boolean" },
      json: { type: "boolean" },
      fixtures: { type: "string" },
      work: { type: "string" },
      only: { type: "string" },
      force: { type: "boolean" },
      id: { type: "string" },
      name: { type: "string" },
      software: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  switch (cmd) {
    case "detect": {
      if (!rest[0]) throw new Error("detect: missing <export>");
      const intake = readExportPath(rest[0]);
      const ctx = new ImportContext(intake.files);
      const adapters = [...loadTemplates(values.template).map(templateAdapter), ...builtInAdapters()];
      const d = detect(ctx, adapters);
      const proposal = proposeMapping(ctx);
      if (values.json) {
        console.log(JSON.stringify({ scores: d.scores, chosen: d.chosen?.name ?? null, ambiguous: d.ambiguous, proposal: proposal.mapping, reasons: proposal.reasons }, null, 2));
        return 0;
      }
      console.log(`${intake.files.length} files (${intake.duplicates.length} duplicates dropped, ${intake.skipped.length} junk skipped)`);
      for (const s of d.scores) console.log(`  ${s.confidence.toFixed(3)}  ${s.adapter}@${s.version}  ${s.reason ?? ""}`);
      console.log(d.chosen ? `→ ${d.chosen.name}` : d.ambiguous ? "→ ambiguous: mapping screen" : "→ no adapter above threshold: mapping screen");
      console.log("\nProposed mapping:");
      for (const e of proposal.mapping.entries)
        console.log(`  ${(e.node ? `${e.path} › ${e.node}` : e.path).padEnd(56)} ${e.role.padEnd(20)} ${(e.jaw ?? "?").padEnd(6)} ${(e.stageLabel ?? "").padEnd(8)} ${e.fdi ?? ""}  (${e.reason ?? ""})`);
      if (proposal.reasons.length) console.log("\nNeeds attention:\n  - " + proposal.reasons.join("\n  - "));
      return 0;
    }
    case "template": {
      if (!rest[0] || !values.id || !values.name) throw new Error("template: need <mapping.json> --id --name");
      const m = JSON.parse(readFileSync(rest[0], "utf8")) as Mapping;
      const t = templateFromMapping(m, { id: values.id, name: values.name, ...(values.software ? { software: values.software } : {}) });
      const json = JSON.stringify(t, null, 2);
      if (values.out) writeFileSync(values.out, json);
      else console.log(json);
      return 0;
    }
    case "inspect": {
      const dir = rest[0];
      if (!dir) throw new Error("inspect: missing <packageDir>");
      const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as PackageMetadata;
      console.log(`${meta.packageFormat}  created ${meta.createdAt}  by ${meta.generator.name}@${meta.generator.version}`);
      console.log(`source: ${meta.case.source.vendor} via ${meta.case.source.adapter.name}@${meta.case.source.adapter.version}`);
      console.log(`stages: ${Object.entries(meta.stagesPerJaw).map(([j, n]) => `${j} ${n}`).join(", ")}`);
      console.log(`compression: ${meta.compression.sourceBytes} → ${meta.compression.meshBytes} bytes (${meta.compression.ratio}×), trimmed-mean error ${meta.compression.errorTrimmedMeanMm} mm, max ${meta.compression.errorMaxMm} mm`);
      console.log(`registration: ${meta.case.registration?.note ?? "n/a"}`);
      for (const w of meta.case.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
      let bad = 0;
      for (const [rel, f] of Object.entries(meta.files)) {
        if (!rel.endsWith(".tsm2")) continue;
        try {
          const d = await decodeTsm2(new Uint8Array(readFileSync(join(dir, rel))));
          if (process.env.VERBOSE) console.log(`  ${rel}: ${d.parts.length} parts, ${d.parts.reduce((s, p) => s + p.triangleCount, 0)} triangles, ${f.bytes} bytes`);
        } catch (e) {
          bad++;
          console.log(`  ${rel}: ${(e as Error).message}`);
        }
      }
      console.log(bad ? `${bad} corrupt file(s)` : "all TSM2 files decode and pass CRC");
      return bad ? 2 : 0;
    }
    case "selfcheck": {
      const results = await runSelfCheck({
        fixturesDir: values.fixtures ?? DEFAULT_FIXTURES,
        workDir: values.work ?? resolve(".selfcheck"),
        ...(values.only ? { only: values.only.split(",") } : {}),
        log: (l) => console.log(l),
      });
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} fixture runs passed`);
      return failed ? 1 : 0;
    }
    case "fixtures": {
      const written = generateFixtures(values.fixtures ?? DEFAULT_FIXTURES, undefined, values.force);
      console.log(written.length ? `generated: ${written.join(", ")}` : "fixtures already present (use --force to regenerate)");
      return 0;
    }
    default: {
      const input = cmd, out = rest[0];
      if (!out) throw new Error("missing <outDir>\n\n" + USAGE);
      if (!existsSync(input)) throw new Error(`export not found: ${input}`);
      const manualMapping = values.mapping ? (JSON.parse(readFileSync(values.mapping, "utf8")) as Mapping) : undefined;
      const result = await processExport(input, out, {
        templates: loadTemplates(values.template),
        ...(values.adapter ? { adapterName: values.adapter } : {}),
        ...(manualMapping ? { manualMapping } : {}),
        package: { overwrite: !!values.overwrite },
        onProgress: values.json ? undefined : (p) => process.stderr.write(`\r[${String(p.percent).padStart(3)}%] ${p.message.padEnd(60)}`),
      });
      if (!values.json) process.stderr.write("\n");
      if (result.status === "needs-mapping") {
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log("Needs mapping:\n  - " + result.reasons.join("\n  - "));
          console.log("\nWrite a mapping file (see `dentosim detect --json`) and re-run with --mapping.");
        }
        return 3;
      }
      if (values.json) {
        console.log(JSON.stringify({ status: result.status, adapter: result.adapter, detection: result.detection, metadata: result.metadata, timingsMs: result.timingsMs }, null, 2));
        return 0;
      }
      const m = result.metadata;
      console.log(`Ready: ${out}`);
      console.log(`  adapter      ${result.adapter.name}@${result.adapter.version} (scores: ${result.detection.map((d) => `${d.adapter} ${d.confidence.toFixed(2)}`).join(", ")})`);
      console.log(`  stages       ${Object.entries(m.stagesPerJaw).map(([j, n]) => `${j} ${n}`).join(", ")}`);
      console.log(`  units        ${result.case.normalization?.sourceUnits} (×${result.case.normalization?.scaleApplied}); bite: ${result.case.normalization?.interArch}`);
      const seg = result.case.segmentation?.jaws;
      if (seg) for (const [j, s] of Object.entries(seg)) console.log(`  ${j.padEnd(12)} ${s!.teeth} teeth, ${s!.attachments} attachments${s!.unsegmented ? ", UNSEGMENTED" : ""}${s!.fusedSplit ? `, ${s!.fusedSplit} fused split` : ""}`);
      console.log(`  registration ${result.case.registration?.note}`);
      console.log(`  compression  ${(m.compression.sourceBytes / 1e6).toFixed(2)} MB → ${(m.compression.meshBytes / 1e6).toFixed(2)} MB (${m.compression.ratio}×), error ${m.compression.errorTrimmedMeanMm} mm`);
      console.log(`  timings      ${Object.entries(result.timingsMs).map(([k, v]) => `${k} ${v}ms`).join(", ")}`);
      for (const w of result.warnings) console.log(`  [${w.severity}] ${w.message}`);
      return 0;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof PipelineError) console.error(`Failed (${e.code}): ${e.userMessage}`);
    else console.error(e instanceof Error ? e.message : e);
    process.exit(e instanceof PipelineError ? 4 : 1);
  },
);
