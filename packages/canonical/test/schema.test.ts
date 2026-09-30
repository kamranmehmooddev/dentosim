import { describe, expect, it } from "vitest";
import { caseStageCount, validateCanonicalManifest } from "../src/index.js";

const minimal = {
  schemaVersion: "1.0",
  units: "mm",
  coordinateSystem: "dentosim-v1",
  arches: {
    upper: {
      jaw: "upper",
      stages: [
        { index: 0, sourceFiles: ["u0.stl"], segmented: true, parts: [{ id: "tooth-11", kind: "tooth", fdi: 11, mesh: { uri: "upper/stage-00.tsm2#tooth-11", vertexCount: 10, triangleCount: 16 } }] },
        { index: 1, sourceFiles: ["u1.stl"], segmented: false, parts: [{ id: "arch", kind: "arch", mesh: { uri: "upper/stage-01.tsm2#arch", vertexCount: 10, triangleCount: 16 } }] },
      ],
    },
  },
  source: { vendor: "generic", adapter: { name: "generic", version: "1.0.0" }, detection: [{ adapter: "generic", version: "1.0.0", confidence: 0.6 }], fileMap: [{ path: "u0.stl", role: "stage", jaw: "upper", stage: 0 }] },
  warnings: [{ code: "NO_INITIAL_STAGE", severity: "warning", message: "…" }],
};

describe("Canonical Case schema", () => {
  it("accepts a minimal valid manifest", () => {
    expect(validateCanonicalManifest(minimal)).toEqual({ valid: true, errors: [] });
    expect(caseStageCount(minimal as never)).toBe(2);
  });

  it("rejects wrong units, unknown kinds, invalid FDI and extra properties", () => {
    const bad = structuredClone(minimal) as Record<string, any>;
    bad.units = "inch";
    bad.arches.upper.stages[0].parts[0].kind = "crown";
    bad.arches.upper.stages[0].parts[0].fdi = 99;
    bad.extra = true;
    const r = validateCanonicalManifest(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("requires at least one arch and one part per stage", () => {
    expect(validateCanonicalManifest({ ...minimal, arches: {} }).valid).toBe(false);
    const noParts = structuredClone(minimal) as Record<string, any>;
    noParts.arches.upper.stages[0].parts = [];
    expect(validateCanonicalManifest(noParts).valid).toBe(false);
  });
});
