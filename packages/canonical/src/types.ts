/**
 * DentoSim Canonical Case — the single internal representation every import
 * adapter produces, whatever planning software the export came from.
 *
 * Units are millimetres. Coordinates use the DentoSim frame
 * (`coordinateSystem: "dentosim-v1"`, see docs/coordinate-system.md):
 *
 *   +X  patient's left
 *   +Y  superior (up; the upper arch sits above the lower arch)
 *   +Z  anterior (incisors point toward +Z)
 *
 * Right-handed. Origin: centre of the occlusal plane of the case.
 *
 * The in-memory form carries mesh data (`CanonicalCase<MeshData>`); the
 * serialised form (JSON manifest, validated by schema/canonical-case.schema.json)
 * carries references to mesh files instead (`CanonicalCase<MeshRef>`).
 */

export const CANONICAL_SCHEMA_VERSION = "1.0" as const;
export const COORDINATE_SYSTEM = "dentosim-v1" as const;

export type Jaw = "upper" | "lower";

/** Indexed triangle mesh, positions in mm. */
export interface MeshData {
  positions: Float32Array; // xyz triplets
  indices: Uint32Array; // triangle list
}

/** Reference to a mesh stored outside the manifest. */
export interface MeshRef {
  uri: string;
  vertexCount: number;
  triangleCount: number;
}

export type PartKind =
  /** a single tooth crown (optionally with root) */
  | "tooth"
  /** gingiva / soft tissue */
  | "gums"
  /** attachment bonded on a tooth */
  | "attachment"
  /** printed model base / plinth */
  | "base"
  /** a complete, unsegmented arch model (teeth + gums fused in one shell) */
  | "arch";

export interface Part<M = MeshData> {
  /** stable id within the arch, identical for the same tooth across stages (e.g. "tooth-11", "gums") */
  id: string;
  kind: PartKind;
  /** FDI tooth number (11–48) when known */
  fdi?: number;
  /** true when the FDI number was estimated from position rather than supplied by the export */
  fdiEstimated?: boolean;
  /** true when the part is procedurally generated (illustrative gums) rather than exported */
  procedural?: boolean;
  mesh: M;
}

export interface Stage<M = MeshData> {
  /** continuous index 0…N; 0 is the initial (malocclusion) stage */
  index: number;
  /** stage label as it appeared in the export (e.g. "03", "initial", "final") */
  sourceLabel?: string;
  /** source files this stage was built from (paths inside the export) */
  sourceFiles: string[];
  /** true when the stage has been split into teeth/gums/attachments */
  segmented: boolean;
  parts: Part<M>[];
}

export interface Arch<M = MeshData> {
  jaw: Jaw;
  /** ordered, continuous stages 0…N. An arch may have fewer stages than its opposite (it finished earlier). */
  stages: Stage<M>[];
}

export interface Scans<M = MeshData> {
  upper?: M;
  lower?: M;
  /** buccal bite scan (both arches in occlusion) */
  bite?: M;
}

/** Cumulative movement of one tooth from stage 0 to `stage`. */
export interface ToothMovement {
  jaw: Jaw;
  toothId: string;
  fdi?: number;
  stage: number;
  /** translation of the crown centroid in the case frame (mm) */
  translationMm: [number, number, number];
  translationMagnitudeMm: number;
  /** translation decomposed in the tooth's arch frame (mm) */
  mesialDistalMm: number;
  buccalLingualMm: number;
  extrusionIntrusionMm: number;
  /** total rotation angle (degrees) */
  rotationDeg: number;
  /** rotation decomposed about the tooth's arch frame axes (degrees) */
  tipDeg: number;
  torqueDeg: number;
  rotationAboutLongAxisDeg: number;
}

export type WarningSeverity = "info" | "warning" | "error";

export interface CaseWarning {
  /** machine-readable code, e.g. "UNITS_CONVERTED_INCH" */
  code: string;
  severity: WarningSeverity;
  /** human-readable message, safe to show to lab staff (never contains PHI) */
  message: string;
  file?: string;
  jaw?: Jaw;
  stage?: number;
}

export interface DetectionScore {
  adapter: string;
  version: string;
  confidence: number;
  reason?: string;
}

export type FileRole =
  | "stage"
  | "scan-upper"
  | "scan-lower"
  | "scan-bite"
  | "attachment-template"
  | "retainer"
  | "base"
  | "tooth"
  | "transforms"
  | "ignore";

/** How one file of the export was used. */
export interface FileMapEntry {
  path: string;
  /** node/object name inside a scene file (OBJ group, 3MF object, glTF node) */
  node?: string;
  role: FileRole;
  /** for role "stage": which part of the stage this file holds (default: complete arch model) */
  partKind?: PartKind;
  jaw?: Jaw;
  /** stage label parsed from the file (before re-indexing) */
  stageLabel?: string;
  /** final continuous stage index */
  stage?: number;
  fdi?: number;
  sizeBytes?: number;
  sha256?: string;
  /** why the file was assigned this role */
  reason?: string;
}

export interface CaseSource {
  /** vendor name, or "generic" / "unknown" */
  vendor: string;
  adapter: { name: string; version: string };
  /** scores of every detector that ran */
  detection: DetectionScore[];
  /** true when a user-confirmed mapping or saved template was applied */
  mappingApplied?: { templateId?: string; manual: boolean };
  fileMap: FileMapEntry[];
}

export interface NormalizationReport {
  sourceUnits: "mm" | "inch" | "cm" | "m";
  scaleApplied: number;
  /** 4×4 column-major rigid transform applied per jaw (after scaling) */
  transforms: Partial<Record<Jaw, number[]>>;
  /** how the relationship between arches was established */
  interArch: "export" | "registered" | "reconstructed" | "single-arch";
  /** occlusal-plane tilt removed, degrees */
  tiltCorrectedDeg: Partial<Record<Jaw, number>>;
}

export interface SegmentationReport {
  performed: boolean;
  /** per jaw summary of stage-0 segmentation */
  jaws: Partial<
    Record<
      Jaw,
      {
        teeth: number;
        attachments: number;
        droppedFragments: number;
        fusedSplit: number;
        unsegmented: boolean;
        proceduralGums: boolean;
      }
    >
  >;
}

export interface RegistrationFit {
  /** 4×4 column-major rigid transform (rotation + translation only) */
  matrix: number[];
  trimmedMeanMm: number;
  medianMm: number;
  rmsMm: number;
  /** fraction of points kept by trimming */
  inlierFraction: number;
  iterations: number;
  starts: number;
}

export interface RegistrationReport {
  performed: boolean;
  method: "pca-multistart-trimmed-icp" | "none";
  /** true when scans were available */
  scansPresent: boolean;
  upper?: RegistrationFit;
  lower?: RegistrationFit;
  /** median distance of bite-scan points to the registered arches, when a bite scan exists */
  biteConsistencyMedianMm?: number;
  /** human-readable statement for the UI */
  note: string;
}

export interface CanonicalCase<M = MeshData> {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  units: "mm";
  coordinateSystem: typeof COORDINATE_SYSTEM;
  arches: Partial<Record<Jaw, Arch<M>>>;
  scans?: Scans<M>;
  toothMovements?: ToothMovement[];
  source: CaseSource;
  normalization?: NormalizationReport;
  segmentation?: SegmentationReport;
  registration?: RegistrationReport;
  warnings: CaseWarning[];
}

/** Number of stages of the longest arch (N+1). */
export function caseStageCount(c: CanonicalCase<unknown>): number {
  return Math.max(0, ...Object.values(c.arches).map((a) => (a ? a.stages.length : 0)));
}

export function jawsOf(c: CanonicalCase<unknown>): Jaw[] {
  return (["upper", "lower"] as const).filter((j) => c.arches[j]);
}
