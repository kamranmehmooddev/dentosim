/**
 * Filename / path inference used by the generic adapter and by mapping templates.
 * Pure string logic — no geometry. Every inference carries a reason so the
 * mapping screen can explain itself.
 */
import type { FileRole, Jaw, PartKind } from "@dentosim/canonical";

export interface NumberToken {
  value: number;
  raw: string;
  /** index into the token list */
  pos: number;
  /** preceded by an explicit stage keyword (stage/step/setup/aligner/…) or of the form "N of M" */
  strong: boolean;
  /** token list index belongs to the filename (true) or a directory (false) */
  inFilename: boolean;
}

export interface PathInfo {
  path: string;
  tokens: string[];
  /** tokens of the filename only */
  nameTokens: string[];
  jaw?: { value: Jaw; source: "filename" | "directory"; token: string };
  /** hint from keywords: scan, attachment template, retainer, base, ignore */
  role?: { value: FileRole; token: string };
  partKind?: { value: PartKind; token: string };
  numbers: NumberToken[];
  initial?: string;
  final?: string;
  fdi?: number;
  /** template signature: tokens with numbers → "#", jaw tokens → "@" */
  signature: string;
}

const UPPER = new Set(["upper", "maxilla", "maxillary", "maxillar", "max", "mx", "top", "u", "uj", "oberkiefer", "superior", "sup", "up"]);
const LOWER = new Set(["lower", "mandible", "mandibular", "mand", "mn", "md", "bottom", "l", "lj", "unterkiefer", "inferior", "inf", "low", "lo"]);
const STAGE_KW = new Set(["stage", "step", "setup", "aligner", "st", "stg", "s", "tray", "phase", "subsetup", "sub"]);
const INITIAL = new Set(["initial", "init", "malocclusion", "malocclusal", "mal", "pre", "start", "begin", "before", "original", "orig", "baseline"]);
const FINAL = new Set(["final", "finish", "finished", "end", "after", "target", "result"]);
const TOOTH_KW = new Set(["tooth", "teeth", "t", "fdi", "zahn"]);

const ROLE_KW: [RegExp, FileRole][] = [
  [/^(bite|bitescan|occlusion|buccal|bucal|occlusal)$/, "scan-bite"],
  [/^(scan|scans|ios|intraoral|raw|impression)$/, "scan-upper"], // jaw decided separately
  [/^(attachment|attachments|att|template|templates)$/, "attachment-template"],
  [/^(retainer|retainers|retention|vivera)$/, "retainer"],
  [/^(plinth|socle|sockel|pedestal)$/, "base"],
  [/^(thumb|thumbnail|preview|logo|label|ruler|report|readme|screenshot|icon)$/, "ignore"],
];

const PART_KW: [RegExp, PartKind][] = [
  [/^(gum|gums|gingiva|gingival|gingivae|soft|tissue|gum3d)$/, "gums"],
  [/^(base)$/, "base"],
];

/** Split a path into lowercase tokens: separators, camelCase and letter/digit boundaries. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

export function analysePath(path: string, node?: string): PathInfo {
  const segs = path.split("/");
  const fileName = stripExtension(segs[segs.length - 1]) + (node ? ` ${node}` : "");
  const dirTokens = segs.slice(0, -1).flatMap(tokenize);
  const nameTokens = tokenize(fileName);
  const tokens = [...dirTokens, ...nameTokens];
  const nameStart = dirTokens.length;
  const info: PathInfo = { path, tokens, nameTokens, numbers: [], signature: "" };

  // jaw: filename wins over directory, explicit words win over single letters
  const jawOf = (t: string): Jaw | undefined => (UPPER.has(t) ? "upper" : LOWER.has(t) ? "lower" : undefined);
  const pickJaw = (from: number, to: number, source: "filename" | "directory") => {
    let best: PathInfo["jaw"];
    for (let i = from; i < to; i++) {
      const j = jawOf(tokens[i]);
      if (!j) continue;
      // single letters are weak: only accept when adjacent to a number or at a boundary
      if (tokens[i].length === 1 && best) continue;
      if (!best || best.token.length === 1) best = { value: j, source, token: tokens[i] };
    }
    return best;
  };
  info.jaw = pickJaw(nameStart, tokens.length, "filename") ?? pickJaw(0, nameStart, "directory");

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const [re, role] of ROLE_KW) if (re.test(t) && !info.role) info.role = { value: role, token: t };
    for (const [re, kind] of PART_KW) if (re.test(t) && !info.partKind) info.partKind = { value: kind, token: t };
    if (INITIAL.has(t)) info.initial = t;
    if (FINAL.has(t)) info.final = t;
    if (/^\d+$/.test(t)) {
      const prev = tokens[i - 1], next = tokens[i + 1];
      const strong = (prev !== undefined && STAGE_KW.has(prev)) || (next === "of" && /^\d+$/.test(tokens[i + 2] ?? ""));
      const isTotal = prev === "of" && i >= 2 && /^\d+$/.test(tokens[i - 2]);
      if (prev !== undefined && TOOTH_KW.has(prev)) {
        const v = parseInt(t, 10);
        if (isFdi(v)) info.fdi = v;
        continue;
      }
      if (!isTotal) info.numbers.push({ value: parseInt(t, 10), raw: t, pos: i, strong, inFilename: i >= nameStart });
    }
  }
  // "base" alone is a base part of a stage, unless nothing else indicates a stage
  info.signature = tokens.map((t) => (/^\d+$/.test(t) ? "#" : jawOf(t) ? "@" : t)).join("_");
  return info;
}

export function isFdi(v: number): boolean {
  const q = Math.floor(v / 10), n = v % 10;
  return q >= 1 && q <= 4 && n >= 1 && n <= 8;
}

/** FDI quadrant → jaw. */
export const jawOfFdi = (fdi: number): Jaw => (Math.floor(fdi / 10) <= 2 ? "upper" : "lower");

/**
 * Pick the stage number of each file. Strong numbers (after a stage keyword)
 * win; otherwise, within files sharing a template signature, the numeric field
 * that varies across files is the stage.
 */
export interface StageNumber {
  value: number;
  label: string;
  reason: string;
  /** a lone, unpatterned number (e.g. "kx7.stl" among unrelated names): not trustworthy as a stage */
  weak?: boolean;
}

export function inferStageNumbers(infos: PathInfo[]): Map<string, StageNumber | undefined> {
  const out = new Map<string, StageNumber | undefined>();
  const bySig = new Map<string, PathInfo[]>();
  for (const i of infos) {
    const k = `${i.signature}|${i.numbers.length}`;
    let g = bySig.get(k);
    if (!g) bySig.set(k, (g = []));
    g.push(i);
  }
  for (const group of bySig.values()) {
    // which numeric field varies across the group?
    const nfields = group[0].numbers.length;
    let varying = -1, bestDistinct = 1;
    for (let f = 0; f < nfields; f++) {
      const distinct = new Set(group.map((g) => g.numbers[f].value)).size;
      // prefer filename fields when tied
      if (distinct > bestDistinct || (distinct === bestDistinct && distinct > 1 && group[0].numbers[f].inFilename)) {
        bestDistinct = distinct;
        varying = f;
      }
    }
    for (const info of group) {
      const strong = info.numbers.filter((n) => n.strong);
      // a number is only trusted as a stage when it is keyword-marked or part of a shared naming pattern
      const weak = group.length === 1 && infos.length > 1;
      const pick = (n: NumberToken, reason: string, strong = false) =>
        out.set(info.path, { value: n.value, label: n.raw, reason, ...(weak && !strong ? { weak: true } : {}) });
      if (strong.length) {
        const n = strong[strong.length - 1];
        const kw = info.tokens[n.pos - 1];
        pick(n, info.tokens[n.pos + 1] === "of" && !STAGE_KW.has(kw ?? "") ? `"${n.raw} of ${info.tokens[n.pos + 2]}" numbering` : `stage keyword "${kw}"`, true);
      }
      else if (varying >= 0) pick(info.numbers[varying], "numbering varies across files");
      else if (info.numbers.length === 1) pick(info.numbers[0], "only number in name");
      else if (info.numbers.length > 1) {
        const inName = info.numbers.filter((n) => n.inFilename);
        const n = inName.length ? inName[inName.length - 1] : info.numbers[info.numbers.length - 1];
        pick(n, "last number in name");
      } else out.set(info.path, undefined);
    }
  }
  return out;
}
