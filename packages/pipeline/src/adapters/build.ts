/**
 * Build a (raw, un-normalised) Canonical Case from a complete file mapping.
 * Shared by the generic adapter, saved mapping templates and the manual
 * mapping screen, so all three produce identical cases for identical mappings.
 */
import {
  CANONICAL_SCHEMA_VERSION,
  COORDINATE_SYSTEM,
  type Arch,
  type CanonicalCase,
  type CaseWarning,
  type DetectionScore,
  type Jaw,
  type Part,
  type PartKind,
  type Stage,
} from "@dentosim/canonical";
import { geometryKey, mergeMeshes, type Mesh } from "../mesh/mesh.js";
import type { ImportContext } from "./context.js";
import type { Mapping, MappingEntry } from "./types.js";

export const INITIAL_ORDER = -1;
export const FINAL_ORDER = Number.MAX_SAFE_INTEGER;

/** Numeric sort key for a stage label ("initial" → -1, "final" → +∞, "07" → 7). */
export function stageOrder(label: string | undefined): number | undefined {
  if (label === undefined) return undefined;
  const l = label.toLowerCase();
  if (l === "initial") return INITIAL_ORDER;
  if (l === "final") return FINAL_ORDER;
  const n = parseInt(l, 10);
  return Number.isFinite(n) ? n : undefined;
}

export class MappingError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("; "));
    this.name = "MappingError";
  }
}

/** Problems that prevent building a case from this mapping (empty = complete). */
export function mappingProblems(mapping: Mapping): string[] {
  const problems: string[] = [];
  const stages = mapping.entries.filter((e) => e.role === "stage" || e.role === "tooth");
  if (stages.length === 0) problems.push("No file is assigned to a treatment stage.");
  for (const e of stages) {
    const where = e.node ? `${e.path} › ${e.node}` : e.path;
    if (!e.jaw) problems.push(`${where}: upper or lower arch not known.`);
    if ((e.order ?? stageOrder(e.stageLabel)) === undefined) problems.push(`${where}: stage number not known.`);
    if (e.role === "tooth" && e.fdi === undefined) problems.push(`${where}: tooth number not known.`);
  }
  return problems;
}

function nodeMesh(ctx: ImportContext, e: MappingEntry): Mesh {
  const loaded = ctx.mesh(e.path);
  if (e.node !== undefined) {
    const n = loaded.nodes.find((x) => x.name === e.node);
    if (!n) throw new MappingError([`${e.path}: node "${e.node}" not found`]);
    return n.mesh;
  }
  return loaded.nodes.length === 1 ? loaded.nodes[0].mesh : mergeMeshes(loaded.nodes.map((n) => n.mesh));
}

export interface BuildOptions {
  adapter: { name: string; version: string };
  vendor: string;
  detection: DetectionScore[];
  mappingApplied?: { templateId?: string; manual: boolean };
  warnings?: CaseWarning[];
}

export function buildCaseFromMapping(ctx: ImportContext, mapping: Mapping, opts: BuildOptions): CanonicalCase {
  const problems = mappingProblems(mapping);
  if (problems.length) throw new MappingError(problems);
  const warnings: CaseWarning[] = [...(opts.warnings ?? [])];
  const entries = mapping.entries.map((e) => ({ ...e, order: e.order ?? stageOrder(e.stageLabel) }));
  const c: CanonicalCase = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    units: "mm",
    coordinateSystem: COORDINATE_SYSTEM,
    arches: {},
    source: {
      vendor: opts.vendor,
      adapter: opts.adapter,
      detection: opts.detection,
      ...(opts.mappingApplied ? { mappingApplied: opts.mappingApplied } : {}),
      fileMap: [],
    },
    warnings,
  };

  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const items = entries.filter((e) => (e.role === "stage" || e.role === "tooth") && e.jaw === jaw);
    if (!items.length) continue;
    const orders = [...new Set(items.map((e) => e.order!))].sort((a, b) => a - b);
    // continuity checks on numbered stages
    const numbered = orders.filter((o) => o !== INITIAL_ORDER && o !== FINAL_ORDER);
    for (let i = 1; i < numbered.length; i++)
      if (numbered[i] !== numbered[i - 1] + 1)
        warnings.push({
          code: "STAGE_GAP",
          severity: "warning",
          jaw,
          message: `${cap(jaw)} arch: stage numbering jumps from ${numbered[i - 1]} to ${numbered[i]}; stages were re-numbered continuously.`,
        });
    if (!orders.includes(INITIAL_ORDER) && !orders.includes(0))
      warnings.push({
        code: "NO_INITIAL_STAGE",
        severity: "warning",
        jaw,
        message: `${cap(jaw)} arch: no stage 0 / initial model found; the first exported stage (${labelOf(items, orders[0])}) is shown as the starting position.`,
      });
    const stages: Stage[] = [];
    let prevKey = "";
    for (const order of orders) {
      const group = items.filter((e) => e.order === order);
      const parts: Part[] = [];
      const usedIds = new Set<string>();
      for (const e of group) {
        const mesh = nodeMesh(ctx, e);
        const kind: PartKind = e.role === "tooth" ? "tooth" : e.partKind ?? "arch";
        let id = kind === "tooth" ? `tooth-${e.fdi}` : kind;
        for (let k = 2; usedIds.has(id); k++) id = `${kind === "tooth" ? `tooth-${e.fdi}` : kind}-${k}`;
        usedIds.add(id);
        parts.push({ id, kind, ...(e.fdi !== undefined ? { fdi: e.fdi } : {}), mesh });
      }
      // identical consecutive stages (e.g. "final" duplicating the last numbered stage) are collapsed
      const key = parts.map((p) => geometryKey(p.mesh)).sort().join("|");
      if (key === prevKey) {
        warnings.push({
          code: "DUPLICATE_STAGE",
          severity: "info",
          jaw,
          message: `${cap(jaw)} arch: stage "${labelOf(items, order)}" is identical to the previous stage and was merged.`,
        });
        stages[stages.length - 1].sourceFiles.push(...group.map((g) => g.path));
        for (const g of group) g.stage = stages.length - 1;
        continue;
      }
      prevKey = key;
      const index = stages.length;
      for (const g of group) g.stage = index;
      stages.push({ index, sourceLabel: labelOf(items, order), sourceFiles: [...new Set(group.map((g) => g.path))], segmented: false, parts });
    }
    c.arches[jaw] = { jaw, stages } satisfies Arch;
  }

  for (const role of ["scan-upper", "scan-lower", "scan-bite"] as const) {
    const scanEntries = entries.filter((e) => e.role === role);
    if (!scanEntries.length) continue;
    if (scanEntries.length > 1)
      warnings.push({
        code: "MULTIPLE_SCANS",
        severity: "warning",
        message: `Several files are marked as the ${role.slice(5)} scan; they were combined.`,
      });
    c.scans ??= {};
    c.scans[role.slice(5) as "upper" | "lower" | "bite"] = mergeMeshes(scanEntries.map((e) => nodeMesh(ctx, e)));
  }

  const lengths = (["upper", "lower"] as const).map((j) => c.arches[j]?.stages.length ?? 0);
  if (lengths[0] && lengths[1] && lengths[0] !== lengths[1]) {
    const shorter = lengths[0] < lengths[1] ? "upper" : "lower";
    warnings.push({
      code: "ARCH_FINISHES_EARLY",
      severity: "info",
      jaw: shorter,
      message: `${cap(shorter)} arch finishes at stage ${Math.min(...lengths) - 1}; it stays in its final position for the remaining stages.`,
    });
  }

  c.source.fileMap = entries.map(({ order: _o, confidence: _c, ...rest }) => {
    const f = ctx.file(rest.path);
    return { ...rest, ...(f ? { sizeBytes: f.size, sha256: f.sha256 } : {}) };
  });
  return c;
}

function labelOf(items: MappingEntry[], order: number): string {
  if (order === INITIAL_ORDER) return items.find((e) => e.order === order)?.stageLabel ?? "initial";
  if (order === FINAL_ORDER) return "final";
  return items.find((e) => e.order === order)?.stageLabel ?? String(order);
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
