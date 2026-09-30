/**
 * Adapter registry + format detection.
 *
 * Every adapter's detector runs. The highest score above DETECTION_THRESHOLD wins,
 * unless the runner-up is within DETECTION_MARGIN — then the result is
 * ambiguous and the lab confirms on the mapping screen (pre-filled by the
 * generic proposal). All scores are recorded on the case.
 */
import type { DetectionScore } from "@dentosim/canonical";
import { buildCaseFromMapping, MappingError } from "./build.js";
import type { ImportContext } from "./context.js";
import { genericAdapter, proposeMapping } from "./generic.js";
import { templateAdapter, type MappingTemplate } from "./template.js";
import type { ImportAdapter, ImportResult, Mapping } from "./types.js";

export const DETECTION_THRESHOLD = 0.3;
export const DETECTION_MARGIN = 0.1;

/**
 * Built-in vendor adapters. Deliberately empty until real sample exports are
 * available for each vendor: formats are never guessed (see docs/adapters.md).
 */
export const VENDOR_ADAPTERS: ImportAdapter[] = [];

export function builtInAdapters(): ImportAdapter[] {
  return [...VENDOR_ADAPTERS, genericAdapter];
}

export interface DetectionOutcome {
  scores: DetectionScore[];
  chosen?: ImportAdapter;
  ambiguous: boolean;
}

export function detect(ctx: ImportContext, adapters: ImportAdapter[]): DetectionOutcome {
  const scored = adapters.map((a) => {
    let d;
    try {
      d = a.detect(ctx);
    } catch (e) {
      d = { confidence: 0, reason: `detector error: ${(e as Error).message}` };
    }
    return { adapter: a, score: { adapter: a.name, version: a.version, confidence: clamp01(d.confidence), reason: d.reason } };
  });
  scored.sort((x, y) => y.score.confidence - x.score.confidence);
  const scores = scored.map((s) => s.score);
  const [top, second] = scored;
  if (!top || top.score.confidence < DETECTION_THRESHOLD) return { scores, ambiguous: false };
  if (second && second.score.confidence >= DETECTION_THRESHOLD && top.score.confidence - second.score.confidence < DETECTION_MARGIN)
    return { scores, ambiguous: true };
  return { scores, chosen: top.adapter, ambiguous: false };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export interface ImportOptions {
  /** organisation's saved mapping templates */
  templates?: MappingTemplate[];
  /** force a specific adapter by name (CLI --adapter) */
  adapterName?: string;
  /** a user-confirmed mapping from the mapping screen */
  manualMapping?: Mapping;
  /** extra adapters (tests, plugins) */
  extraAdapters?: ImportAdapter[];
}

export interface ImportOutcome {
  result: ImportResult;
  detection: DetectionScore[];
  adapter?: { name: string; version: string };
}

export function runImport(ctx: ImportContext, opts: ImportOptions = {}): ImportOutcome {
  const adapters = [...(opts.extraAdapters ?? []), ...(opts.templates ?? []).map(templateAdapter), ...builtInAdapters()];
  const det = detect(ctx, adapters);

  if (opts.manualMapping) {
    try {
      const c = buildCaseFromMapping(ctx, opts.manualMapping, {
        adapter: { name: "manual-mapping", version: "1.0.0" },
        vendor: "unknown",
        detection: det.scores,
        mappingApplied: { manual: true },
      });
      return { result: { kind: "case", case: c, mapping: opts.manualMapping }, detection: det.scores, adapter: c.source.adapter };
    } catch (e) {
      if (!(e instanceof MappingError)) throw e;
      return { result: { kind: "needs-mapping", proposal: opts.manualMapping, reasons: e.reasons, warnings: [] }, detection: det.scores };
    }
  }

  let adapter = det.chosen;
  if (opts.adapterName) {
    adapter = adapters.find((a) => a.name === opts.adapterName);
    if (!adapter) throw new Error(`Unknown adapter "${opts.adapterName}". Available: ${adapters.map((a) => a.name).join(", ")}`);
  }
  if (!adapter) {
    const p = proposeMapping(ctx);
    const reasons = det.ambiguous
      ? [`Export matches several formats equally well (${det.scores.slice(0, 2).map((s) => `${s.adapter} ${s.confidence.toFixed(2)}`).join(" vs ")}); please confirm the file mapping.`]
      : ["The export format was not recognised; please map the files."];
    return { result: { kind: "needs-mapping", proposal: p.mapping, reasons: [...reasons, ...p.reasons], warnings: p.warnings }, detection: det.scores };
  }
  const result = adapter.import(ctx);
  if (result.kind === "case") result.case.source.detection = det.scores;
  return { result, detection: det.scores, adapter: { name: adapter.name, version: adapter.version } };
}
