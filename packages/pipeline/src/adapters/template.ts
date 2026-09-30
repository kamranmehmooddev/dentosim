/**
 * Mapping templates: when a lab confirms a mapping on the mapping screen, the
 * mapping is generalised into path rules and stored per organisation. The next
 * export from the same software matches those rules and imports automatically.
 *
 * Generalisation: every digit run in a path becomes \d+; the digit run that held
 * the stage number becomes a capture group. Everything else must match literally
 * (case-insensitive), so a template only fires on exports with the same layout.
 */
import type { FileRole, Jaw, PartKind } from "@dentosim/canonical";
import { buildCaseFromMapping, FINAL_ORDER, INITIAL_ORDER, mappingProblems, stageOrder } from "./build.js";
import type { ImportContext } from "./context.js";
import { mappingUnits } from "./generic.js";
import type { Detection, ImportAdapter, ImportResult, Mapping, MappingEntry } from "./types.js";

export interface TemplateRule {
  /** regex over "path" or "path#node", anchored, case-insensitive */
  pattern: string;
  role: FileRole;
  jaw?: Jaw;
  partKind?: PartKind;
  fdi?: number;
  /** 1-based capture group holding the stage number */
  stageGroup?: number;
  /** fixed stage label ("initial" / "final") when the name carries no number */
  stageLabel?: string;
}

export interface MappingTemplate {
  id: string;
  name: string;
  /** planning software the lab says this came from (free text) */
  software?: string;
  createdAt: string;
  rules: TemplateRule[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unitKey = (e: { path: string; node?: string }) => (e.node !== undefined ? `${e.path}#${e.node}` : e.path);

/** Generalise one confirmed mapping entry into a rule. */
export function ruleFromEntry(e: MappingEntry, literalDigits = false): TemplateRule {
  const key = unitKey(e);
  const runs = literalDigits ? [] : [...key.matchAll(/\d+/g)];
  let stageRun = -1;
  if (e.stageLabel !== undefined && /^\d+$/.test(e.stageLabel)) {
    // the last digit run equal to the stage label (numeric compare tolerates zero padding)
    for (let i = runs.length - 1; i >= 0; i--)
      if (parseInt(runs[i][0], 10) === parseInt(e.stageLabel, 10)) { stageRun = i; break; }
  }
  let pattern = "^";
  let last = 0;
  runs.forEach((r, i) => {
    pattern += escapeRe(key.slice(last, r.index));
    pattern += i === stageRun ? "(\\d+)" : "\\d+";
    last = r.index! + r[0].length;
  });
  pattern += escapeRe(key.slice(last)) + "$";
  const rule: TemplateRule = { pattern, role: e.role };
  if (e.jaw) rule.jaw = e.jaw;
  if (e.partKind) rule.partKind = e.partKind;
  if (e.fdi !== undefined) rule.fdi = e.fdi;
  if (stageRun >= 0) rule.stageGroup = 1;
  else if (e.stageLabel !== undefined) rule.stageLabel = e.stageLabel;
  return rule;
}

/** Create a reusable template from a user-confirmed mapping. */
export function templateFromMapping(mapping: Mapping, meta: { id: string; name: string; software?: string; createdAt?: string }): MappingTemplate {
  // patterns that would map to different assignments keep their digits literally
  // (e.g. "q1.stl" → stage 0, "q2.stl" → stage 1: the digits are the only distinguishing part)
  const byPattern = new Map<string, Set<string>>();
  for (const e of mapping.entries) {
    const { pattern, ...assign } = ruleFromEntry(e);
    byPattern.set(pattern, (byPattern.get(pattern) ?? new Set()).add(JSON.stringify(assign)));
  }
  const seen = new Set<string>();
  const rules: TemplateRule[] = [];
  for (const e of mapping.entries) {
    let r = ruleFromEntry(e);
    if ((byPattern.get(r.pattern)?.size ?? 0) > 1) r = ruleFromEntry(e, true);
    const k = JSON.stringify(r);
    if (seen.has(k)) continue;
    seen.add(k);
    rules.push(r);
  }
  // more literal characters first → the most specific rule wins
  rules.sort((a, b) => literalLength(b.pattern) - literalLength(a.pattern));
  return { id: meta.id, name: meta.name, ...(meta.software ? { software: meta.software } : {}), createdAt: meta.createdAt ?? new Date().toISOString(), rules };
}

const literalLength = (p: string) => p.replace(/\\d\+|\(\\d\+\)|\\/g, "").length;

export interface TemplateMatch {
  mapping: Mapping;
  matched: number;
  total: number;
  unmatched: string[];
  /** rules that assign stages but matched nothing */
  unusedStageRules: number;
}

export function applyTemplate(ctx: ImportContext, template: MappingTemplate): TemplateMatch {
  const units = mappingUnits(ctx);
  const compiled = template.rules.map((r) => ({ r, re: new RegExp(r.pattern, "i"), used: false }));
  const entries: MappingEntry[] = [];
  const unmatched: string[] = [];
  for (const u of units) {
    const key = unitKey(u);
    const hit = compiled.find((c) => c.re.test(key));
    if (!hit) {
      unmatched.push(key);
      continue;
    }
    hit.used = true;
    const m = hit.re.exec(key)!;
    const e: MappingEntry = { path: u.path, ...(u.node !== undefined ? { node: u.node } : {}), role: hit.r.role, confidence: 1, reason: `template "${template.name}"` };
    if (hit.r.jaw) e.jaw = hit.r.jaw;
    if (hit.r.partKind) e.partKind = hit.r.partKind;
    if (hit.r.fdi !== undefined) e.fdi = hit.r.fdi;
    if (hit.r.stageGroup) e.stageLabel = m[hit.r.stageGroup];
    else if (hit.r.stageLabel !== undefined) e.stageLabel = hit.r.stageLabel;
    if (e.stageLabel !== undefined) e.order = stageOrder(e.stageLabel);
    if (e.stageLabel === "initial") e.order = INITIAL_ORDER;
    if (e.stageLabel === "final") e.order = FINAL_ORDER;
    entries.push(e);
  }
  const unusedStageRules = compiled.filter((c) => !c.used && (c.r.role === "stage" || c.r.role === "tooth")).length;
  return { mapping: { entries }, matched: units.length - unmatched.length, total: units.length, unmatched, unusedStageRules };
}

export const TEMPLATE_ADAPTER_VERSION = "1.0.0";

/** Wrap an organisation's saved template as an import adapter. */
export function templateAdapter(template: MappingTemplate): ImportAdapter {
  return {
    name: `template:${template.id}`,
    version: TEMPLATE_ADAPTER_VERSION,
    vendor: template.software ?? "unknown",
    detect(ctx: ImportContext): Detection {
      const m = applyTemplate(ctx, template);
      if (m.total === 0) return { confidence: 0, reason: "no mesh files" };
      const frac = m.matched / m.total;
      const stages = m.mapping.entries.filter((e) => e.role === "stage" || e.role === "tooth").length;
      if (stages === 0) return { confidence: 0, reason: "template assigns no stages" };
      // every file must match and every stage rule should be exercised
      const confidence = frac < 1 ? frac * 0.5 : m.unusedStageRules > 0 ? 0.7 : 0.95;
      return { confidence, reason: `${m.matched}/${m.total} files match saved template "${template.name}"` };
    },
    import(ctx: ImportContext): ImportResult {
      const m = applyTemplate(ctx, template);
      const problems = mappingProblems(m.mapping);
      if (m.unmatched.length) problems.push(`${m.unmatched.length} file(s) not covered by template "${template.name}": ${m.unmatched.slice(0, 5).join(", ")}`);
      if (problems.length) return { kind: "needs-mapping", proposal: m.mapping, reasons: problems, warnings: [] };
      const c = buildCaseFromMapping(ctx, m.mapping, {
        adapter: { name: this.name, version: TEMPLATE_ADAPTER_VERSION },
        vendor: this.vendor,
        detection: [],
        mappingApplied: { templateId: template.id, manual: false },
      });
      return { kind: "case", case: c, mapping: m.mapping };
    },
  };
}
