import { createRequire } from "node:module";
import * as Ajv2020Module from "ajv/dist/2020.js";
import type { CanonicalCase, MeshRef } from "./types.js";

const require = createRequire(import.meta.url);
/** The Canonical Case JSON Schema (draft 2020-12). */
export const canonicalCaseSchema: object = require("../schema/canonical-case.schema.json");

// ajv ships CJS; under NodeNext the constructor sits on `.default`.
const Ajv2020 = Ajv2020Module.default.default ?? Ajv2020Module.default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateFn = ajv.compile(canonicalCaseSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a serialised Canonical Case manifest against the JSON Schema. */
export function validateCanonicalManifest(manifest: unknown): ValidationResult {
  const valid = validateFn(manifest) as boolean;
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  return { valid, errors };
}

export function assertCanonicalManifest(manifest: unknown): asserts manifest is CanonicalCase<MeshRef> {
  const r = validateCanonicalManifest(manifest);
  if (!r.valid) throw new Error(`Invalid Canonical Case manifest:\n  ${r.errors.join("\n  ")}`);
}
