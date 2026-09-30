/**
 * The processing pipeline as one pure, deterministic function:
 *
 *   intake → validate → detect + import → units → segment → register → orient
 *          → FDI / movements / procedural gums → compress + package
 *
 * Identical in the CLI, the tests/self-check and the queue worker.
 */
import type { CanonicalCase, CaseWarning, DetectionScore } from "@dentosim/canonical";
import { ImportContext } from "./adapters/context.js";
import { runImport, type ImportOptions } from "./adapters/registry.js";
import type { Mapping } from "./adapters/types.js";
import { DEFAULT_LIMITS, IntakeError, readExportPath, type IntakeLimits, type IntakeResult } from "./io/input.js";
import { normalizeUnits } from "./normalize/units.js";
import { writePackage, type PackageMetadata, type PackageOptions } from "./package/package.js";
import { orientCase } from "./process/orient.js";
import { registerCase, DEFAULT_ICP } from "./process/register.js";
import { segmentCase, DEFAULT_SEGMENT_OPTIONS } from "./process/segment.js";
import { addProceduralGums, computeMovements, estimateFdi } from "./process/teeth.js";

export type PipelineStep = "intake" | "validate" | "import" | "normalize" | "segment" | "register" | "orient" | "teeth" | "package";

export interface Progress {
  step: PipelineStep;
  /** overall 0–100 */
  percent: number;
  message: string;
}

const STEP_RANGE: Record<PipelineStep, [number, number]> = {
  intake: [0, 5], validate: [5, 12], import: [12, 25], normalize: [25, 28], segment: [28, 45],
  register: [45, 60], orient: [60, 65], teeth: [65, 72], package: [72, 100],
};

export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    /** safe to show to lab staff */
    public readonly userMessage: string,
    public readonly retryable = false,
  ) {
    super(userMessage);
    this.name = "PipelineError";
  }
}

export interface ProcessOptions extends ImportOptions {
  limits?: IntakeLimits;
  package?: PackageOptions;
  onProgress?: (p: Progress) => void;
}

export type ProcessResult =
  | {
      status: "ready";
      case: CanonicalCase;
      metadata: PackageMetadata;
      detection: DetectionScore[];
      adapter: { name: string; version: string };
      mapping: Mapping;
      warnings: CaseWarning[];
      timingsMs: Partial<Record<PipelineStep, number>>;
    }
  | {
      status: "needs-mapping";
      proposal: Mapping;
      reasons: string[];
      detection: DetectionScore[];
      warnings: CaseWarning[];
      timingsMs: Partial<Record<PipelineStep, number>>;
    };

/** Run the pipeline on an export already read into memory (worker) or a path (CLI). */
export async function processExport(input: string | IntakeResult, outDir: string, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const timings: Partial<Record<PipelineStep, number>> = {};
  let current: PipelineStep = "intake";
  let t0 = Date.now();
  const step = (s: PipelineStep, message: string, frac = 0) => {
    if (s !== current) {
      timings[current] = Date.now() - t0;
      t0 = Date.now();
      current = s;
    }
    const [a, b] = STEP_RANGE[s];
    opts.onProgress?.({ step: s, percent: Math.round(a + (b - a) * frac), message });
  };
  // yield to the event loop between heavy steps so progress/heartbeats get out
  const tick = () => new Promise((r) => setImmediate(r));

  step("intake", "Reading upload");
  let intake: IntakeResult;
  try {
    intake = typeof input === "string" ? readExportPath(input, opts.limits ?? DEFAULT_LIMITS) : input;
  } catch (e) {
    if (e instanceof IntakeError) throw new PipelineError(`INTAKE_${e.code}`, e.message);
    throw e;
  }

  step("validate", `Checking ${intake.files.length} files`);
  const ctx = new ImportContext(intake.files);
  if (ctx.meshFiles.length === 0) throw new PipelineError("NO_MESHES", "The upload contains no 3D model files (STL, OBJ, PLY, 3MF, glTF).");
  const failures = ctx.parseAll();
  if (failures.length)
    throw new PipelineError(
      "MESH_PARSE",
      `${failures.length} model file(s) could not be read: ${failures.slice(0, 3).map((f) => f.error).join("; ")}${failures.length > 3 ? " …" : ""}`,
    );
  await tick();

  step("import", "Detecting export format");
  const imported = runImport(ctx, opts);
  if (imported.result.kind === "needs-mapping") {
    timings[current] = Date.now() - t0;
    return {
      status: "needs-mapping",
      proposal: imported.result.proposal,
      reasons: imported.result.reasons,
      detection: imported.detection,
      warnings: imported.result.warnings,
      timingsMs: timings,
    };
  }
  const c = imported.result.case;
  await tick();

  step("normalize", "Detecting units");
  const units = normalizeUnits(c);

  step("segment", "Separating teeth, gums and attachments");
  c.segmentation = segmentCase(c, DEFAULT_SEGMENT_OPTIONS);
  await tick();

  step("register", c.scans ? "Registering bite to patient scans" : "No scans: keeping the export's bite");
  c.registration = registerCase(c, DEFAULT_ICP);
  await tick();

  step("orient", "Levelling the occlusal plane");
  const orientation = orientCase(c, c.registration.performed);
  c.normalization = { sourceUnits: units.units, scaleApplied: units.factor, ...orientation };

  step("teeth", "Numbering teeth and measuring movements");
  addProceduralGums(c);
  for (const j of ["upper", "lower"] as const) estimateFdi(c, j);
  const movements = computeMovements(c);
  if (movements.length) c.toothMovements = movements;
  await tick();

  step("package", "Compressing stages");
  const metadata = await writePackage(c, outDir, {
    ...opts.package,
    onProgress: (f, m) => {
      step("package", m, f);
      opts.package?.onProgress?.(f, m);
    },
  });
  timings[current] = Date.now() - t0;
  opts.onProgress?.({ step: "package", percent: 100, message: "Ready" });
  return {
    status: "ready",
    case: c,
    metadata,
    detection: imported.detection,
    adapter: imported.adapter ?? c.source.adapter,
    mapping: imported.result.mapping,
    warnings: c.warnings,
    timingsMs: timings,
  };
}
