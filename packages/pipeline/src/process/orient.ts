/**
 * Orientation normalisation into the DentoSim frame:
 *   +Y up (upper arch above lower), +Z anterior (incisors forward), +X patient left,
 *   occlusal plane level (XZ plane), origin at the centre of the occlusal plane.
 *
 * Undoes 3D-print tilts (models stood up or tilted for printing), and handles
 * exports where the two arches were laid out separately (both base-down,
 * side by side): then the relationship is reconstructed and flagged.
 * Rotations only — never a mirror.
 */
import type { CanonicalCase, Jaw, NormalizationReport } from "@dentosim/canonical";
import {
  cross, dot, identity4, multiply4, normalize, quantile, scale, sub, toFrame, transformPoint, translation4, type Mat4, type Vec3,
} from "../math/linalg.js";
import { mergeMeshes, sampleSurface, surfaceCentroid, transformMesh, type Mesh } from "../mesh/mesh.js";
import { archAxes, crownDirection } from "../normalize/archframe.js";

export interface ArchFrame {
  /** world → DentoSim rotation+translation for this arch alone (origin at arch centroid) */
  matrix: Mat4;
  up: Vec3;
  anterior: Vec3;
  centroid: Vec3;
  crownConfidence: number;
}

function stage0(c: CanonicalCase, jaw: Jaw): { all: Mesh; teeth?: Mesh; soft?: Mesh } {
  const parts = c.arches[jaw]!.stages[0].parts;
  const teeth = parts.filter((p) => p.kind === "tooth");
  const soft = parts.filter((p) => p.kind === "gums" || p.kind === "base");
  return {
    all: mergeMeshes(parts.filter((p) => p.kind !== "base" && p.kind !== "attachment").map((p) => p.mesh)),
    ...(teeth.length >= 3 ? { teeth: mergeMeshes(teeth.map((p) => p.mesh)) } : {}),
    ...(soft.length ? { soft: mergeMeshes(soft.map((p) => p.mesh)) } : {}),
  };
}

/** Compute the frame of one arch from its stage-0 geometry. */
export function archFrame(c: CanonicalCase, jaw: Jaw): ArchFrame {
  const s = stage0(c, jaw);
  // teeth define the occlusal plane best; fall back to the whole model
  const samples = sampleSurface(s.teeth ?? s.all, 8000, 21);
  const axes = archAxes(samples);
  const allSamples = s.teeth ? sampleSurface(s.all, 8000, 22) : samples;
  const crown = crownDirection(allSamples, axes, s.teeth ? surfaceCentroid(s.teeth) : undefined, s.soft ? surfaceCentroid(s.soft) : undefined);
  // upper crowns point down, lower crowns point up
  const up = jaw === "upper" ? scale(crown.dir, -1) : crown.dir;
  const anterior = normalize(sub(axes.anterior, scale(up, dot(axes.anterior, up))));
  const x = normalize(cross(up, anterior)); // X = Y × Z
  return { matrix: toFrame(x, up, anterior, axes.centroid), up, anterior, centroid: axes.centroid, crownConfidence: crown.confidence };
}

/** Degrees between a direction and the nearest coordinate axis of the source file. */
function tiltFromAxes(v: Vec3): number {
  const m = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  return +((Math.acos(Math.min(1, m)) * 180) / Math.PI).toFixed(2);
}

const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

/** Occlusal-level Y: where the crown tips are (5th/95th percentile of teeth heights). */
function crownTipLevel(m: Mesh, jaw: Jaw): number {
  const ys = new Float64Array(m.positions.length / 3);
  for (let i = 0; i < ys.length; i++) ys[i] = m.positions[i * 3 + 1];
  return jaw === "upper" ? quantile(ys, 0.02) : quantile(ys, 0.98);
}

export function orientCase(c: CanonicalCase, registered: boolean): Pick<NormalizationReport, "transforms" | "interArch" | "tiltCorrectedDeg"> {
  const jaws = (["upper", "lower"] as Jaw[]).filter((j) => c.arches[j]);
  const frames = Object.fromEntries(jaws.map((j) => [j, archFrame(c, j)])) as Partial<Record<Jaw, ArchFrame>>;
  const transforms: Partial<Record<Jaw, Mat4>> = {};
  let interArch: NormalizationReport["interArch"] = jaws.length === 1 ? "single-arch" : registered ? "registered" : "export";

  if (jaws.length === 2) {
    const U = frames.upper!, L = frames.lower!;
    // is the export's relationship plausible? (same plane, same facing, lower below upper, overlapping)
    const lowerInU = transformPoint(U.matrix, L.centroid);
    const consistent =
      angleDeg(U.up, L.up) < 25 && angleDeg(U.anterior, L.anterior) < 30 && lowerInU[1] < 0 && Math.hypot(lowerInU[0], lowerInU[2]) < 20;
    if (consistent || registered) {
      // one common transform keeps the bite exactly as exported/registered
      transforms.upper = U.matrix;
      transforms.lower = U.matrix;
      if (!consistent)
        c.warnings.push({ code: "ORIENTATION_CHECK", severity: "warning", message: "The registered arches look unusual (different planes or crossed arches); please review the bite." });
    } else {
      interArch = "reconstructed";
      transforms.upper = U.matrix;
      transforms.lower = L.matrix;
      c.warnings.push({
        code: "INTER_ARCH_RECONSTRUCTED",
        severity: "warning",
        message: "The export does not contain a usable bite relationship (arches laid out separately, e.g. for printing). The arches were placed in approximate occlusion for display; no patient scans were available to register the real bite.",
      });
    }
  } else transforms[jaws[0]] = frames[jaws[0]]!.matrix;

  for (const j of jaws) applyToArch(c, j, transforms[j]!);

  // vertical placement: occlusal plane at y = 0, arches centred in X/Z
  const tips = Object.fromEntries(jaws.map((j) => [j, crownTipLevel(stage0(c, j).teeth ?? stage0(c, j).all, j)])) as Partial<Record<Jaw, number>>;
  const centre = surfaceCentroid(mergeMeshes(jaws.map((j) => stage0(c, j).teeth ?? stage0(c, j).all)));
  if (interArch === "reconstructed") {
    // put each arch's tips 0.2 mm off the plane, centred on each other
    for (const j of jaws) {
      const own = surfaceCentroid(stage0(c, j).teeth ?? stage0(c, j).all);
      const shift = translation4([-own[0], (j === "upper" ? 0.2 : -0.2) - tips[j]!, -own[2]]);
      applyToArch(c, j, shift);
      transforms[j] = multiply4(shift, transforms[j]!);
    }
  } else {
    const planeY = jaws.length === 2 ? (tips.upper! + tips.lower!) / 2 : tips[jaws[0]]!;
    const shift = translation4([-centre[0], -planeY, -centre[2]]);
    for (const j of jaws) {
      applyToArch(c, j, shift);
      transforms[j] = multiply4(shift, transforms[j]!);
    }
  }
  // scans follow the upper (or only) arch transform so they stay in register
  if (c.scans) {
    const T = transforms.upper ?? transforms.lower ?? identity4();
    for (const k of ["upper", "lower", "bite"] as const) if (c.scans[k]) c.scans[k] = transformMesh(c.scans[k]!, T);
  }
  const tilt: Partial<Record<Jaw, number>> = {};
  for (const j of jaws) {
    const lowConfidence = frames[j]!.crownConfidence < 0.5;
    tilt[j] = tiltFromAxes(frames[j]!.up);
    if (lowConfidence)
      c.warnings.push({ code: "ORIENTATION_UNCERTAIN", severity: "warning", jaw: j, message: `${j === "upper" ? "Upper" : "Lower"} arch: which side the crowns face was hard to determine; please check the arch is not upside down.` });
  }
  return { transforms, interArch, tiltCorrectedDeg: tilt };
}

function applyToArch(c: CanonicalCase, jaw: Jaw, T: Mat4): void {
  for (const st of c.arches[jaw]!.stages) for (const p of st.parts) p.mesh = transformMesh(p.mesh, T);
}
