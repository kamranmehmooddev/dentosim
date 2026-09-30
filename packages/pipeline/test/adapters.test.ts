import { describe, expect, it } from "vitest";
import { ImportContext } from "../src/adapters/context.js";
import { analysePath, inferStageNumbers, tokenize } from "../src/adapters/filenames.js";
import { proposeMapping } from "../src/adapters/generic.js";
import { detect, DETECTION_MARGIN, runImport } from "../src/adapters/registry.js";
import { applyTemplate, ruleFromEntry, templateFromMapping } from "../src/adapters/template.js";
import type { ImportAdapter } from "../src/adapters/types.js";
import { writeBinaryStl } from "../src/io/loaders.js";
import { readExportFiles } from "../src/io/input.js";
import { makeArch, stageModel } from "../src/fixtures/synth.js";

const upper = makeArch({ jaw: "upper", seed: 1, stages: 3 });
const lower = makeArch({ jaw: "lower", seed: 2, stages: 3 });
const U = [0, 1, 2, 3].map((k) => writeBinaryStl(stageModel(upper, k).full));
const L = [0, 1, 2, 3].map((k) => writeBinaryStl(stageModel(lower, k).full));

const ctxOf = (files: [string, Uint8Array][]) => new ImportContext(readExportFiles(files.map(([path, data]) => ({ path, data }))).files);

describe("filename inference", () => {
  it("tokenises separators, camelCase and digit boundaries", () => {
    expect(tokenize("UpperJaw_Stage03of21")).toEqual(["upper", "jaw", "stage", "03", "of", "21"]);
    expect(tokenize("LJ-s12")).toEqual(["lj", "s", "12"]);
  });

  it.each([
    ["Upper_Stage_03.stl", "upper"], ["maxillary 3.stl", "upper"], ["Max03.stl", "upper"], ["top_03.stl", "upper"],
    ["UJ_03.stl", "upper"], ["U03.stl", "upper"], ["lower.stl", "lower"], ["Mandibular_7.stl", "lower"], ["mand-7.stl", "lower"],
    ["bottom 7.stl", "lower"], ["LJ7.stl", "lower"], ["L07.stl", "lower"], ["Upper/07.stl", "upper"],
  ])("jaw of %s → %s", (p, jaw) => {
    expect(analysePath(p).jaw?.value).toBe(jaw);
  });

  it.each([
    [["Upper 01.stl", "Upper 02.stl"], [1, 2]],
    [["case_10482_upper_3_.stl", "case_10482_upper_4_.stl"], [3, 4]],
    [["stage3.stl"], [3]],
    [["Upper 03_of_21.stl", "Upper 04_of_21.stl"], [3, 4]],
    [["step 3 upper.stl", "step 4 upper.stl"], [3, 4]],
    [["2024-05-01 Upper s1.stl", "2024-05-01 Upper s2.stl"], [1, 2]],
  ])("stage numbers of %j", (paths, nums) => {
    const infos = (paths as string[]).map((p) => analysePath(p));
    const m = inferStageNumbers(infos);
    expect(infos.map((i) => m.get(i.path)?.value)).toEqual(nums);
  });

  it("recognises initial / final / roles", () => {
    expect(analysePath("Upper malocclusion.stl").initial).toBe("malocclusion");
    expect(analysePath("Upper Final.stl").final).toBe("final");
    expect(analysePath("upper_scan.ply").role?.value).toBe("scan-upper");
    expect(analysePath("bite registration.stl").role?.value).toBe("scan-bite");
    expect(analysePath("Attachment template U.stl").role?.value).toBe("attachment-template");
    expect(analysePath("retainer_upper.stl").role?.value).toBe("retainer");
    expect(analysePath("Setup 2/tooth_46.stl").fdi).toBe(46);
  });
});

describe("generic adapter", () => {
  it("maps a numbered two-arch export completely", () => {
    const ctx = ctxOf([...U.map((d, k) => [`Upper/Upper_${k}.stl`, d] as [string, Uint8Array]), ...L.map((d, k) => [`Lower/Lower_${k}.stl`, d] as [string, Uint8Array])]);
    const p = proposeMapping(ctx);
    expect(p.reasons).toEqual([]);
    expect(p.mapping.entries.filter((e) => e.jaw === "upper").map((e) => e.order)).toEqual([0, 1, 2, 3]);
  });

  it("treats 'initial' as stage 0 before numbered stages", () => {
    const ctx = ctxOf([["U initial.stl", U[0]], ["U 1.stl", U[1]], ["U 2.stl", U[2]]]);
    const r = runImport(ctx);
    expect(r.result.kind).toBe("case");
    if (r.result.kind !== "case") return;
    expect(r.result.case.arches.upper!.stages.map((s) => s.sourceLabel)).toEqual(["initial", "1", "2"]);
  });

  it("reports conflicts instead of guessing", () => {
    const ctx = ctxOf([["Upper_1.stl", U[1]], ["upper-1.stl", U[2]]]);
    const p = proposeMapping(ctx);
    expect(p.reasons.join(" ")).toMatch(/claim upper stage 1/);
  });

  it("re-numbers gaps continuously and warns", () => {
    const ctx = ctxOf([["Upper_0.stl", U[0]], ["Upper_1.stl", U[1]], ["Upper_3.stl", U[3]]]);
    const r = runImport(ctx);
    if (r.result.kind !== "case") throw new Error("expected case");
    expect(r.result.case.arches.upper!.stages.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(r.result.case.warnings.map((w) => w.code)).toContain("STAGE_GAP");
  });
});

describe("detection", () => {
  const fake = (name: string, confidence: number): ImportAdapter => ({
    name, version: "1", vendor: name,
    detect: () => ({ confidence, reason: "test" }),
    import: () => { throw new Error("not used"); },
  });
  const ctx = ctxOf([["a.stl", U[0]]]);

  it("picks the highest score above threshold", () => {
    const d = detect(ctx, [fake("a", 0.9), fake("b", 0.5)]);
    expect(d.chosen?.name).toBe("a");
    expect(d.scores.map((s) => s.adapter)).toEqual(["a", "b"]);
  });

  it("declares ambiguity when the top two are within the margin", () => {
    const d = detect(ctx, [fake("a", 0.8), fake("b", 0.8 - DETECTION_MARGIN / 2)]);
    expect(d.ambiguous).toBe(true);
    expect(d.chosen).toBeUndefined();
  });

  it("falls back to the mapping screen when nothing qualifies", () => {
    const r = runImport(ctxOf([["a.stl", U[0]], ["b.stl", U[1]], ["c.stl", L[0]]]), { extraAdapters: [fake("x", 0.1)] });
    expect(r.detection.length).toBeGreaterThanOrEqual(2);
    expect(r.result.kind).toBe("needs-mapping");
  });

  it("records every detector's score on the case", () => {
    const ctx2 = ctxOf([["Upper_0.stl", U[0]], ["Upper_1.stl", U[1]]]);
    const r = runImport(ctx2, { extraAdapters: [fake("vendor-x", 0.1)] });
    if (r.result.kind !== "case") throw new Error("expected case");
    expect(r.result.case.source.detection.map((d) => d.adapter).sort()).toEqual(["generic", "vendor-x"]);
  });
});

describe("mapping templates", () => {
  it("generalises digits and captures the stage", () => {
    const rule = ruleFromEntry({ path: "Case 10482/UJ_step07.stl", role: "stage", jaw: "upper", stageLabel: "07" });
    expect(rule.pattern).toBe("^Case \\d+/UJ_step(\\d+)\\.stl$");
    expect(rule.stageGroup).toBe(1);
    expect(new RegExp(rule.pattern, "i").exec("Case 99/UJ_step12.stl")?.[1]).toBe("12");
  });

  it("applies a saved template to a new export from the same software", () => {
    const mapping = {
      entries: [
        { path: "q1.stl", role: "stage" as const, jaw: "upper" as const, stageLabel: "0" },
        { path: "q2.stl", role: "stage" as const, jaw: "upper" as const, stageLabel: "1" },
        { path: "w1.stl", role: "stage" as const, jaw: "lower" as const, stageLabel: "0" },
      ],
    };
    const t = templateFromMapping(mapping, { id: "t1", name: "Acme" });
    // "q1"/"q2" differ only by digits, so their digits stay literal; "w1" generalises
    expect(t.rules.map((r) => r.pattern).sort()).toEqual(["^q1\\.stl$", "^q2\\.stl$", "^w\\d+\\.stl$"]);
    const m = applyTemplate(ctxOf([["q1.stl", U[0]], ["q2.stl", U[1]], ["w3.stl", L[0]]]), t);
    expect(m.unmatched).toEqual([]);
    expect(m.mapping.entries.find((e) => e.path === "q2.stl")).toMatchObject({ jaw: "upper", stageLabel: "1" });
    expect(m.mapping.entries.find((e) => e.path === "w3.stl")).toMatchObject({ jaw: "lower", stageLabel: "0" });
    expect(applyTemplate(ctxOf([["q7.stl", U[0]]]), t).unmatched).toEqual(["q7.stl"]);
  });
});
