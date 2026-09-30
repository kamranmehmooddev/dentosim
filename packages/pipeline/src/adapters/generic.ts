/**
 * Generic adapter — the fallback for any export that no vendor adapter claims:
 * numbered model folders, loose STL/OBJ/PLY/3MF/glTF files, scene files with
 * one node per stage, and per-tooth mesh files.
 *
 * It infers, per file (or per scene node):
 *   jaw   from path words (upper/lower, max/mand, maxillary/mandibular, U/L, UJ/LJ,
 *         top/bottom, …) and, when words are missing, from geometry (palate present?)
 *   stage from stage keywords (stage3, step 3, 03_of_21, s03), the numeric field that
 *         varies across files, and initial/malocclusion/final words
 *   role  scans, bite scans, attachment templates, retainers, bases, ignorable files
 *
 * If anything stays ambiguous it returns "needs-mapping" with its best proposal,
 * so the lab lands on the mapping screen rather than a dead end.
 */
import type { CaseWarning, Jaw } from "@dentosim/canonical";
import { guessJawFromGeometry } from "../normalize/archframe.js";
import { mergeMeshes } from "../mesh/mesh.js";
import { buildCaseFromMapping, FINAL_ORDER, INITIAL_ORDER, MappingError, mappingProblems } from "./build.js";
import type { ImportContext } from "./context.js";
import { analysePath, inferStageNumbers, jawOfFdi, tokenize, type PathInfo } from "./filenames.js";
import type { Detection, ImportAdapter, ImportResult, Mapping, MappingEntry } from "./types.js";

export const GENERIC_ADAPTER_NAME = "generic";
export const GENERIC_ADAPTER_VERSION = "1.0.0";

interface Unit {
  path: string;
  node?: string;
  info: PathInfo;
}

/** Enumerate mapping units: a file, or each named node of a multi-node scene file. */
export function mappingUnits(ctx: ImportContext): Unit[] {
  const units: Unit[] = [];
  for (const f of ctx.meshFiles) {
    let nodes: string[] = [];
    try {
      const loaded = ctx.mesh(f.path);
      if (loaded.nodes.length > 1) nodes = loaded.nodes.map((n) => n.name);
    } catch {
      /* parse failures are reported by validation */
    }
    // a scene whose node names carry stage/jaw information is mapped per node
    const nodesInformative =
      nodes.length > 1 &&
      new Set(nodes).size === nodes.length &&
      nodes.some((n) => tokenize(n).some((t) => /^\d+$/.test(t) || JAW_WORDS.has(t)));
    if (nodesInformative) for (const n of nodes) units.push({ path: f.path, node: n, info: analysePath(f.path, n) });
    else units.push({ path: f.path, info: analysePath(f.path) });
  }
  return units;
}

const JAW_WORDS = new Set(["upper", "lower", "maxilla", "maxillary", "mandible", "mandibular", "max", "mand", "top", "bottom", "u", "l", "uj", "lj"]);

export function proposeMapping(ctx: ImportContext): { mapping: Mapping; reasons: string[]; warnings: CaseWarning[] } {
  const units = mappingUnits(ctx);
  const warnings: CaseWarning[] = [];
  const reasons: string[] = [];
  const entries: MappingEntry[] = [];
  const key = (u: Unit) => (u.node !== undefined ? `${u.path}#${u.node}` : u.path);

  // 1. roles from keywords
  const stageUnits: Unit[] = [];
  for (const u of units) {
    const r = u.info.role?.value;
    if (r === "scan-upper" || r === "scan-bite") {
      const isBite = r === "scan-bite" || (!u.info.jaw && /bite|occlu/.test(u.info.tokens.join(" ")));
      const role = isBite ? "scan-bite" : u.info.jaw?.value === "lower" ? "scan-lower" : "scan-upper";
      entries.push({
        path: u.path, ...(u.node !== undefined ? { node: u.node } : {}), role,
        ...(role !== "scan-bite" && u.info.jaw ? { jaw: u.info.jaw.value } : {}),
        confidence: role === "scan-bite" || u.info.jaw ? 0.9 : 0.3,
        reason: `keyword "${u.info.role!.token}"`,
      });
      if (role === "scan-upper" && !u.info.jaw) reasons.push(`${key(u)}: looks like a scan but upper/lower is unclear.`);
    } else if (r) {
      entries.push({ path: u.path, ...(u.node !== undefined ? { node: u.node } : {}), role: r, confidence: 0.85, reason: `keyword "${u.info.role!.token}"` });
    } else stageUnits.push(u);
  }

  // 2. stage numbers
  const stageNums = inferStageNumbers(stageUnits.map((u) => ({ ...u.info, path: key(u) })));

  // 3. jaws — words first, then geometry per sequence
  const jawFor = new Map<string, { jaw: Jaw; confidence: number; reason: string }>();
  for (const u of stageUnits) {
    if (u.info.fdi !== undefined) jawFor.set(key(u), { jaw: jawOfFdi(u.info.fdi), confidence: 0.95, reason: `tooth ${u.info.fdi}` });
    else if (u.info.jaw)
      jawFor.set(key(u), {
        jaw: u.info.jaw.value,
        confidence: u.info.jaw.token.length > 1 ? 0.95 : 0.8,
        reason: `${u.info.jaw.source} word "${u.info.jaw.token}"`,
      });
  }
  // files next to files of a single known jaw (e.g. gingiva beside tooth_11.stl) inherit that jaw
  const dirOf = (u: Unit) => (u.path.includes("/") ? u.path.slice(0, u.path.lastIndexOf("/")) : "");
  const dirJaws = new Map<string, Set<Jaw>>();
  for (const u of stageUnits) {
    const j = jawFor.get(key(u));
    if (j) dirJaws.set(dirOf(u), (dirJaws.get(dirOf(u)) ?? new Set()).add(j.jaw));
  }
  for (const u of stageUnits) {
    const js = dirJaws.get(dirOf(u));
    if (!jawFor.has(key(u)) && js?.size === 1 && dirOf(u) !== "")
      jawFor.set(key(u), { jaw: [...js][0], confidence: 0.85, reason: "same folder as other files of this arch" });
  }
  const unknown = stageUnits.filter((u) => !jawFor.has(key(u)));
  if (unknown.length) {
    // sequences = same directory + same signature
    const seqs = new Map<string, Unit[]>();
    for (const u of unknown) {
      const dir = u.path.includes("/") ? u.path.slice(0, u.path.lastIndexOf("/")) : "";
      const k = `${dir}|${u.info.signature}`;
      let s = seqs.get(k);
      if (!s) seqs.set(k, (s = []));
      s.push(u);
    }
    const knownJaws = new Set([...jawFor.values()].map((j) => j.jaw));
    const guesses = [...seqs.values()].map((seq) => {
      // guess from the lowest-numbered model of the sequence
      const first = [...seq].sort((a, b) => (stageNums.get(key(a))?.value ?? 0) - (stageNums.get(key(b))?.value ?? 0))[0];
      try {
        const loaded = ctx.mesh(first.path);
        const mesh = first.node !== undefined ? loaded.nodes.find((n) => n.name === first.node)!.mesh : mergeMeshes(loaded.nodes.map((n) => n.mesh));
        return { seq, ...guessJawFromGeometry(mesh) };
      } catch {
        return { seq, jaw: "upper" as Jaw, confidence: 0, palate: 0 };
      }
    });
    // relative decision: sequences split cleanly into "palate" and "no palate" groups
    const withPalate = guesses.filter((g) => g.palate >= 0.6), without = guesses.filter((g) => g.palate <= 0.4);
    if (withPalate.length && without.length && withPalate.length + without.length === guesses.length) {
      for (const g of withPalate) { g.jaw = "upper"; g.confidence = 0.8; }
      for (const g of without) { g.jaw = "lower"; g.confidence = 0.8; }
    } else if (guesses.length === 1 && knownJaws.size === 1) {
      // the other jaw is already named: this sequence must be the opposite one
      guesses[0].jaw = knownJaws.has("upper") ? "lower" : "upper";
      guesses[0].confidence = 0.8;
    }
    for (const g of guesses) {
      for (const u of g.seq)
        jawFor.set(key(u), { jaw: g.jaw, confidence: g.confidence, reason: `geometry (palate ${g.palate >= 0.6 ? "present" : "absent"})` });
      if (g.confidence >= 0.7)
        warnings.push({
          code: "JAW_FROM_GEOMETRY",
          severity: "warning",
          jaw: g.jaw,
          message: `${g.seq.length} file(s) had no upper/lower in their names; they were identified as the ${g.jaw} arch from their shape. Please confirm in the viewer.`,
        });
      else reasons.push(`${g.seq.length} file(s) have no upper/lower in their names and the arch could not be identified from shape (e.g. ${key(g.seq[0])}).`);
    }
  }

  // 4. assemble stage entries
  const weak = new Set<string>();
  for (const u of stageUnits) {
    const k = key(u);
    const j = jawFor.get(k);
    const num = stageNums.get(k);
    let order: number | undefined;
    let label: string | undefined;
    let reason = "";
    if (u.info.initial && !num) { order = INITIAL_ORDER; label = "initial"; reason = `word "${u.info.initial}"`; }
    else if (u.info.initial && num && num.value === 0) { order = 0; label = num.label; reason = num.reason; }
    else if (u.info.initial && num) { order = INITIAL_ORDER; label = "initial"; reason = `word "${u.info.initial}"`; }
    else if (u.info.final && !num) { order = FINAL_ORDER; label = "final"; reason = `word "${u.info.final}"`; }
    else if (num) {
      order = num.value; label = num.label; reason = num.reason;
      if (num.weak) weak.add(k);
    }
    const isTooth = u.info.fdi !== undefined;
    entries.push({
      path: u.path,
      ...(u.node !== undefined ? { node: u.node } : {}),
      role: isTooth ? "tooth" : "stage",
      ...(isTooth ? { fdi: u.info.fdi } : {}),
      ...(u.info.partKind && !isTooth ? { partKind: u.info.partKind.value } : {}),
      ...(j ? { jaw: j.jaw } : {}),
      ...(label !== undefined ? { stageLabel: label, order } : {}),
      confidence: Math.min(j?.confidence ?? 0, order !== undefined ? 0.95 : 0),
      reason: [j?.reason, reason].filter(Boolean).join("; "),
    });
  }

  // a lone model per jaw without any number is that jaw's only (initial) stage
  for (const jaw of ["upper", "lower"] as Jaw[]) {
    const js = entries.filter((e) => (e.role === "stage" || e.role === "tooth") && e.jaw === jaw);
    const unnumbered = js.filter((e) => e.order === undefined);
    if (js.length === 1 && unnumbered.length === 1) {
      unnumbered[0].order = 0;
      unnumbered[0].stageLabel = "0";
      unnumbered[0].reason += "; single model";
    }
  }

  // conflicts: several full-arch models claiming the same jaw + stage
  const slots = new Map<string, MappingEntry[]>();
  for (const e of entries)
    if (e.role === "stage" && e.jaw && e.order !== undefined && !e.partKind) {
      const k = `${e.jaw}|${e.order}`;
      slots.set(k, [...(slots.get(k) ?? []), e]);
    }
  for (const [k, all] of slots) {
    // byte-identical copies of the same model are redundant, not conflicting
    const list: MappingEntry[] = [];
    const seen = new Map<string, MappingEntry>();
    for (const e of all) {
      const sha = e.node === undefined ? ctx.file(e.path)?.sha256 : undefined;
      const first = sha ? seen.get(sha) : undefined;
      if (first) {
        e.role = "ignore";
        e.reason = `identical to ${first.path}`;
        delete e.jaw; delete e.stageLabel; delete e.order;
        warnings.push({ code: "DUPLICATE_FILE", severity: "info", file: e.path, message: `${e.path} is identical to ${first.path} and was ignored.` });
        continue;
      }
      if (sha) seen.set(sha, e);
      list.push(e);
    }
    if (list.length > 1) {
      const [jaw, order] = k.split("|");
      reasons.push(`${list.length} different models claim ${jaw} stage ${order === String(INITIAL_ORDER) ? "initial" : order}: ${list.map((e) => e.path).join(", ")}.`);
      for (const e of list) e.confidence = 0.3;
    }
  }

  // unpatterned numbers only matter for files that are still used as stages
  for (const e of entries)
    if (e.role === "stage" && weak.has(e.node !== undefined ? `${e.path}#${e.node}` : e.path)) {
      reasons.push(`${e.node !== undefined ? `${e.path} › ${e.node}` : e.path}: the number in this name does not follow a stage-numbering pattern shared with other files.`);
      e.confidence = Math.min(e.confidence ?? 0, 0.4);
    }
  const mapping: Mapping = { entries };
  reasons.push(...mappingProblems(mapping));
  return { mapping, reasons: [...new Set(reasons)], warnings };
}

export const genericAdapter: ImportAdapter = {
  name: GENERIC_ADAPTER_NAME,
  version: GENERIC_ADAPTER_VERSION,
  vendor: "generic",

  detect(ctx: ImportContext): Detection {
    const meshes = ctx.meshFiles.length;
    if (meshes === 0) return { confidence: 0, reason: "no mesh files" };
    const { mapping, reasons } = proposeMapping(ctx);
    const stageEntries = mapping.entries.filter((e) => e.role === "stage" || e.role === "tooth");
    const resolved = stageEntries.filter((e) => e.jaw && e.order !== undefined).length;
    const coverage = stageEntries.length ? resolved / stageEntries.length : 0;
    // the generic adapter never outranks a vendor adapter that recognises its export
    const confidence = +(0.2 + 0.4 * coverage * (reasons.length ? 0.5 : 1)).toFixed(3);
    return { confidence, reason: `${resolved}/${stageEntries.length} stage models resolved from names/geometry` };
  },

  import(ctx: ImportContext): ImportResult {
    const { mapping, reasons, warnings } = proposeMapping(ctx);
    if (reasons.length) return { kind: "needs-mapping", proposal: mapping, reasons, warnings };
    try {
      const c = buildCaseFromMapping(ctx, mapping, {
        adapter: { name: GENERIC_ADAPTER_NAME, version: GENERIC_ADAPTER_VERSION },
        vendor: "generic",
        detection: [],
        warnings,
      });
      return { kind: "case", case: c, mapping };
    } catch (e) {
      if (e instanceof MappingError) return { kind: "needs-mapping", proposal: mapping, reasons: e.reasons, warnings };
      throw e;
    }
  },
};
