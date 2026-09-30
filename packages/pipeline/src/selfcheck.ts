/**
 * Self-check: runs every fixture in fixtures/<name>/expected.json through the
 * exact same `processExport` used by the CLI and the worker, and compares the
 * outcome with the recorded expectations. Run by `dentosim selfcheck`, by the
 * test-suite, and by the worker at start-up (`WORKER_SELFCHECK=1`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CanonicalCase, Jaw } from "@dentosim/canonical";
import type { Mapping } from "./adapters/types.js";
import { templateFromMapping, type MappingTemplate } from "./adapters/template.js";
import { FIXTURES, fixtureZip, ZIPPED_FIXTURES } from "./fixtures/catalog.js";
import { surfaceCentroid, mergeMeshes } from "./mesh/mesh.js";
import { processExport, type ProcessResult } from "./pipeline.js";
import { decodeTsm2 } from "./tsm2/tsm2.js";
import type { PackageMetadata } from "./package/package.js";

export interface Expectation {
  status: "ready" | "needs-mapping";
  adapter?: string;
  adapterPrefix?: string;
  arches?: Partial<Record<Jaw, number>>;
  sourceUnits?: string;
  interArch?: string;
  segmentation?: Partial<Record<Jaw, { teeth?: number; attachments?: number; unsegmented?: boolean; fusedSplit?: number; minDroppedFragments?: number; proceduralGums?: boolean }>>;
  registration?: { performed: boolean; maxTrimmedMeanMm?: number };
  compression?: { minRatio?: number; maxErrorTrimmedMeanMm?: number };
  warnings?: string[];
  noWarnings?: string[];
  anatomy?: boolean;
  bite?: { upperFdi: number; lowerFdi: number; distanceMm: number; toleranceMm: number };
  fdiCount?: Partial<Record<Jaw, number>>;
  minMovements?: number;
  minReasons?: number;
}

export interface FixtureRun {
  name: string;
  mapping?: string;
  templateFromMapping?: string;
  templates?: string[];
  adapter?: string;
  expect: Expectation;
}

export interface FixtureSpec {
  synthetic?: boolean;
  description?: string;
  input: string;
  runs: FixtureRun[];
}

export interface CheckResult {
  fixture: string;
  run: string;
  ok: boolean;
  failures: string[];
  durationMs: number;
  summary: string;
}

/** Write synthetic fixture exports (idempotent). */
export function generateFixtures(fixturesDir: string, only?: string[], force = false): string[] {
  const written: string[] = [];
  for (const f of FIXTURES) {
    if (only && !only.includes(f.name)) continue;
    const dir = join(fixturesDir, f.name);
    const zipped = ZIPPED_FIXTURES.has(f.name);
    const target = join(dir, zipped ? "export.zip" : "export");
    if (existsSync(target) && !force) continue;
    rmSync(target, { recursive: true, force: true });
    const files = f.files();
    if (zipped) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, fixtureZip(files));
    } else
      for (const file of files) {
        const p = join(target, file.path);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, file.data);
      }
    written.push(f.name);
  }
  return written;
}

const teethOf = (c: CanonicalCase, jaw: Jaw) => c.arches[jaw]?.stages[0].parts.filter((p) => p.kind === "tooth") ?? [];

function checkAnatomy(c: CanonicalCase, failures: string[]): void {
  const cent = (jaw: Jaw, pick: (fdi: number) => boolean) => {
    const t = teethOf(c, jaw).filter((p) => p.fdi !== undefined && pick(p.fdi));
    return t.length ? surfaceCentroid(mergeMeshes(t.map((p) => p.mesh))) : undefined;
  };
  const all = (jaw: Jaw) => cent(jaw, () => true);
  const up = all("upper"), lo = all("lower");
  if (up && lo && !(up[1] > lo[1])) failures.push(`anatomy: upper teeth (y=${up[1].toFixed(1)}) not above lower (y=${lo[1].toFixed(1)})`);
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const inc = cent(jaw, (f) => f % 10 <= 2), mol = cent(jaw, (f) => f % 10 >= 6);
    if (inc && mol && !(inc[2] > mol[2])) failures.push(`anatomy: ${jaw} incisors not anterior of molars`);
    const right = cent(jaw, (f) => Math.floor(f / 10) === (jaw === "upper" ? 1 : 4));
    const left = cent(jaw, (f) => Math.floor(f / 10) === (jaw === "upper" ? 2 : 3));
    if (right && left && !(right[0] < 0 && left[0] > 0)) failures.push(`anatomy: ${jaw} quadrants on the wrong sides (right x=${right[0].toFixed(1)}, left x=${left[0].toFixed(1)})`);
    // occlusal plane level: incisor tips and molar tips within a few mm vertically
    const teeth = teethOf(c, jaw);
    if (teeth.length) {
      const ys = teeth.map((t) => surfaceCentroid(t.mesh)[1]);
      if (Math.max(...ys) - Math.min(...ys) > 8) failures.push(`anatomy: ${jaw} occlusal plane not level (tooth centroid heights span ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} mm)`);
    }
  }
}

async function checkPackage(outDir: string, meta: PackageMetadata, failures: string[]): Promise<void> {
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const arch = meta.case.arches[jaw];
    if (!arch) continue;
    for (const st of arch.stages) {
      const file = st.parts[0].mesh.uri.split("#")[0];
      const decoded = await decodeTsm2(new Uint8Array(readFileSync(join(outDir, file))));
      if (decoded.parts.length !== st.parts.length) failures.push(`package: ${file} has ${decoded.parts.length} parts, manifest lists ${st.parts.length}`);
    }
  }
}

export async function verifyExpectation(result: ProcessResult, e: Expectation, outDir: string): Promise<string[]> {
  const f: string[] = [];
  if (result.status !== e.status) {
    f.push(`status ${result.status}, expected ${e.status}${result.status === "needs-mapping" ? `: ${result.reasons.join(" | ")}` : ""}`);
    return f;
  }
  if (result.status === "needs-mapping") {
    if (e.minReasons !== undefined && result.reasons.length < e.minReasons) f.push(`expected ≥${e.minReasons} mapping reasons, got ${result.reasons.length}`);
    if (!result.proposal.entries.length) f.push("needs-mapping without a proposal");
    return f;
  }
  const c = result.case;
  if (e.adapter && result.adapter.name !== e.adapter) f.push(`adapter ${result.adapter.name}, expected ${e.adapter}`);
  if (e.adapterPrefix && !result.adapter.name.startsWith(e.adapterPrefix)) f.push(`adapter ${result.adapter.name}, expected ${e.adapterPrefix}*`);
  for (const [jaw, n] of Object.entries(e.arches ?? {}) as [Jaw, number][]) {
    const got = c.arches[jaw]?.stages.length ?? 0;
    if (got !== n) f.push(`${jaw}: ${got} stages, expected ${n}`);
  }
  for (const jaw of ["upper", "lower"] as Jaw[]) if (e.arches && !(jaw in e.arches) && c.arches[jaw]) f.push(`unexpected ${jaw} arch`);
  if (e.sourceUnits && c.normalization?.sourceUnits !== e.sourceUnits) f.push(`units ${c.normalization?.sourceUnits}, expected ${e.sourceUnits}`);
  if (e.interArch && c.normalization?.interArch !== e.interArch) f.push(`interArch ${c.normalization?.interArch}, expected ${e.interArch}`);
  for (const [jaw, s] of Object.entries(e.segmentation ?? {}) as [Jaw, NonNullable<Expectation["segmentation"]>[Jaw]][]) {
    const got = c.segmentation?.jaws[jaw];
    if (!got) { f.push(`segmentation: no report for ${jaw}`); continue; }
    if (s!.teeth !== undefined && got.teeth !== s!.teeth) f.push(`${jaw}: ${got.teeth} teeth, expected ${s!.teeth}`);
    if (s!.attachments !== undefined && got.attachments !== s!.attachments) f.push(`${jaw}: ${got.attachments} attachments, expected ${s!.attachments}`);
    if (s!.unsegmented !== undefined && got.unsegmented !== s!.unsegmented) f.push(`${jaw}: unsegmented=${got.unsegmented}, expected ${s!.unsegmented}`);
    if (s!.fusedSplit !== undefined && got.fusedSplit !== s!.fusedSplit) f.push(`${jaw}: fusedSplit=${got.fusedSplit}, expected ${s!.fusedSplit}`);
    if (s!.proceduralGums !== undefined && got.proceduralGums !== s!.proceduralGums) f.push(`${jaw}: proceduralGums=${got.proceduralGums}, expected ${s!.proceduralGums}`);
    if (s!.minDroppedFragments !== undefined && got.droppedFragments < s!.minDroppedFragments) f.push(`${jaw}: dropped ${got.droppedFragments} fragments, expected ≥${s!.minDroppedFragments}`);
  }
  if (e.registration) {
    const r = c.registration!;
    if (r.performed !== e.registration.performed) f.push(`registration performed=${r.performed}, expected ${e.registration.performed}`);
    if (e.registration.maxTrimmedMeanMm !== undefined)
      for (const fit of [r.upper, r.lower]) if (fit && fit.trimmedMeanMm > e.registration.maxTrimmedMeanMm) f.push(`registration trimmed mean ${fit.trimmedMeanMm} mm > ${e.registration.maxTrimmedMeanMm}`);
  }
  const comp = result.metadata.compression;
  if (e.compression?.minRatio !== undefined && comp.ratio < e.compression.minRatio) f.push(`compression ratio ${comp.ratio}× < ${e.compression.minRatio}×`);
  if (e.compression?.maxErrorTrimmedMeanMm !== undefined && comp.errorTrimmedMeanMm > e.compression.maxErrorTrimmedMeanMm) f.push(`compression error ${comp.errorTrimmedMeanMm} mm > ${e.compression.maxErrorTrimmedMeanMm}`);
  const codes = new Set(c.warnings.map((w) => w.code));
  for (const w of e.warnings ?? []) if (!codes.has(w)) f.push(`missing warning ${w} (got ${[...codes].join(", ") || "none"})`);
  for (const w of e.noWarnings ?? []) if (codes.has(w)) f.push(`unexpected warning ${w}`);
  if (e.anatomy) checkAnatomy(c, f);
  if (e.bite) {
    const a = teethOf(c, "upper").find((p) => p.fdi === e.bite!.upperFdi), b = teethOf(c, "lower").find((p) => p.fdi === e.bite!.lowerFdi);
    if (!a || !b) f.push(`bite: tooth ${e.bite.upperFdi}/${e.bite.lowerFdi} not found`);
    else {
      const ca = surfaceCentroid(a.mesh), cb = surfaceCentroid(b.mesh);
      const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
      if (Math.abs(d - e.bite.distanceMm) > e.bite.toleranceMm) f.push(`bite: ${e.bite.upperFdi}↔${e.bite.lowerFdi} distance ${d.toFixed(3)} mm, expected ${e.bite.distanceMm} ± ${e.bite.toleranceMm}`);
    }
  }
  for (const [jaw, n] of Object.entries(e.fdiCount ?? {}) as [Jaw, number][]) {
    const got = teethOf(c, jaw).filter((p) => p.fdi !== undefined).length;
    if (got !== n) f.push(`${jaw}: ${got} numbered teeth, expected ${n}`);
  }
  if (e.minMovements !== undefined && (c.toothMovements?.length ?? 0) < e.minMovements) f.push(`only ${c.toothMovements?.length ?? 0} tooth movements`);
  await checkPackage(outDir, result.metadata, f);
  return f;
}

export function loadFixtureSpecs(fixturesDir: string): { name: string; dir: string; spec: FixtureSpec }[] {
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(fixturesDir, d.name, "expected.json")))
    .map((d) => ({ name: d.name, dir: join(fixturesDir, d.name), spec: JSON.parse(readFileSync(join(fixturesDir, d.name, "expected.json"), "utf8")) as FixtureSpec }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SelfCheckOptions {
  fixturesDir: string;
  workDir: string;
  only?: string[];
  log?: (line: string) => void;
}

export async function runSelfCheck(opts: SelfCheckOptions): Promise<CheckResult[]> {
  const fixturesDir = resolve(opts.fixturesDir);
  const specs = loadFixtureSpecs(fixturesDir).filter((s) => !opts.only || opts.only.includes(s.name));
  generateFixtures(fixturesDir, specs.filter((s) => s.spec.synthetic).map((s) => s.name));
  const results: CheckResult[] = [];
  for (const { name, dir, spec } of specs) {
    for (const run of spec.runs) {
      const t0 = Date.now();
      const out = join(opts.workDir, name, run.name);
      let failures: string[] = [];
      let summary = "";
      try {
        const templates: MappingTemplate[] = (run.templates ?? []).map((t) => JSON.parse(readFileSync(join(dir, t), "utf8")));
        if (run.templateFromMapping) {
          const m = JSON.parse(readFileSync(join(dir, run.templateFromMapping), "utf8")) as Mapping;
          templates.push(templateFromMapping(m, { id: `${name}-tpl`, name: `${name} template`, createdAt: "2026-01-01T00:00:00.000Z" }));
        }
        const manualMapping = run.mapping ? (JSON.parse(readFileSync(join(dir, run.mapping), "utf8")) as Mapping) : undefined;
        const result = await processExport(join(dir, spec.input), out, {
          templates,
          ...(manualMapping ? { manualMapping } : {}),
          ...(run.adapter ? { adapterName: run.adapter } : {}),
          package: { overwrite: true, createdAt: "2026-01-01T00:00:00.000Z" },
        });
        failures = await verifyExpectation(result, run.expect, out);
        summary =
          result.status === "ready"
            ? `${result.adapter.name}; ${Object.entries(result.metadata.stagesPerJaw).map(([j, n]) => `${j} ${n}`).join(", ")} stages; ${result.metadata.compression.ratio}× smaller, error ${result.metadata.compression.errorTrimmedMeanMm} mm` +
              (result.case.registration?.performed ? `; fit ${[result.case.registration.upper, result.case.registration.lower].filter(Boolean).map((r) => r!.trimmedMeanMm).join("/")} mm` : "")
            : `needs mapping (${result.reasons.length} reason(s))`;
      } catch (e) {
        failures.push(`threw: ${(e as Error).stack ?? e}`);
      }
      const r: CheckResult = { fixture: name, run: run.name, ok: failures.length === 0, failures, durationMs: Date.now() - t0, summary };
      results.push(r);
      opts.log?.(`${r.ok ? "PASS" : "FAIL"}  ${name} › ${run.name}  (${(r.durationMs / 1000).toFixed(1)} s)  ${summary}${r.ok ? "" : "\n      - " + failures.join("\n      - ")}`);
    }
  }
  return results;
}
