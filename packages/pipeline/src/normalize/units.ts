/**
 * Unit detection: a dental arch is roughly 35–60 mm wide (up to ~80 mm with a
 * printed base). Exports in inches, centimetres or metres are recognised from
 * the arch width and converted to millimetres.
 */
import type { CanonicalCase, CaseWarning, NormalizationReport } from "@dentosim/canonical";
import { dot, pca, quantile, sub } from "../math/linalg.js";
import { mergeMeshes, sampleSurface, scaleMesh, type Mesh } from "../mesh/mesh.js";

export type Units = NormalizationReport["sourceUnits"];

const FACTORS: [Units, number][] = [
  ["mm", 1],
  ["inch", 25.4],
  ["cm", 10],
  ["m", 1000],
];
const PLAUSIBLE_MM: [number, number] = [25, 120];
const TYPICAL_MM = 55;

/** Robust arch width: 2–98 % extent along the main principal axis. */
export function archWidth(m: Mesh): number {
  const s = sampleSurface(m, 4000, 7);
  if (s.length === 0) return 0;
  const p = pca(s);
  const proj = new Float64Array(s.length / 3);
  for (let i = 0; i < proj.length; i++) proj[i] = dot(sub([s[i * 3], s[i * 3 + 1], s[i * 3 + 2]], p.centroid), p.axes[0]);
  return quantile(proj, 0.98) - quantile(proj, 0.02);
}

export function detectUnits(width: number): { units: Units; factor: number; plausible: boolean } {
  if (width >= PLAUSIBLE_MM[0] && width <= PLAUSIBLE_MM[1]) return { units: "mm", factor: 1, plausible: true };
  let best = FACTORS[0], bestErr = Infinity;
  for (const f of FACTORS) {
    const err = Math.abs(Math.log((width * f[1]) / TYPICAL_MM));
    if (err < bestErr) { bestErr = err; best = f; }
  }
  const w = width * best[1];
  return { units: best[0], factor: best[1], plausible: w >= PLAUSIBLE_MM[0] && w <= PLAUSIBLE_MM[1] };
}

const UNIT_NAME: Record<Units, string> = { mm: "millimetres", inch: "inches", cm: "centimetres", m: "metres" };

/** Detect and convert units of the stage models and, separately, of the scans. */
export function normalizeUnits(c: CanonicalCase): { units: Units; factor: number } {
  const stage0 = (["upper", "lower"] as const).flatMap((j) => (c.arches[j] ? [mergeMeshes(c.arches[j]!.stages[0].parts.map((p) => p.mesh))] : []));
  const widths = stage0.map(archWidth).sort((a, b) => a - b);
  const width = widths[widths.length >> 1] ?? 0;
  const u = detectUnits(width);
  const push = (w: CaseWarning) => c.warnings.push(w);
  if (u.factor !== 1)
    push({
      code: `UNITS_CONVERTED_${u.units.toUpperCase()}`,
      severity: "info",
      message: `Models appear to be in ${UNIT_NAME[u.units]} (arch width ${width.toPrecision(3)}); converted to millimetres.`,
    });
  if (!u.plausible)
    push({
      code: "UNITS_UNCERTAIN",
      severity: "warning",
      message: `Arch width (${(width * u.factor).toFixed(1)} mm after conversion) is outside the expected range; please check the model scale.`,
    });
  for (const arch of Object.values(c.arches))
    for (const st of arch!.stages) for (const p of st.parts) p.mesh = scaleMesh(p.mesh, u.factor);

  if (c.scans) {
    const archScanFactor = c.scans.upper || c.scans.lower ? scanFactor(c) : u.factor;
    for (const k of ["upper", "lower", "bite"] as const) {
      const m = c.scans[k];
      if (!m) continue;
      // bite scans are partial; judge them by the arch scans' factor when present
      const su = k === "bite" ? undefined : detectUnits(archWidth(m));
      const factor = su?.factor ?? archScanFactor;
      if (factor !== 1)
        push({ code: "SCAN_UNITS_CONVERTED", severity: "info", message: `The ${k} scan was scaled ×${factor} to millimetres.` });
      c.scans[k] = scaleMesh(m, factor);
    }
  }
  return u;
}

function scanFactor(c: CanonicalCase): number {
  const m = c.scans?.upper ?? c.scans?.lower;
  return m ? detectUnits(archWidth(m)).factor : 1;
}
