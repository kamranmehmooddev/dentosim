import type { CanonicalCase, CaseWarning, FileMapEntry } from "@dentosim/canonical";
import type { ImportContext } from "./context.js";

/** A file → role assignment proposed by an adapter or confirmed by a user. */
export interface MappingEntry extends FileMapEntry {
  /** sort key for stages (initial = -1, final = +Infinity); derived from stageLabel */
  order?: number;
  /** 0–1: how sure the proposer is about this entry */
  confidence?: number;
}

export interface Mapping {
  entries: MappingEntry[];
}

export type ImportResult =
  | { kind: "case"; case: CanonicalCase; mapping: Mapping }
  | {
      kind: "needs-mapping";
      /** best-effort proposal to pre-fill the mapping screen */
      proposal: Mapping;
      /** human-readable reasons the mapping could not be completed automatically */
      reasons: string[];
      warnings: CaseWarning[];
    };

export interface Detection {
  confidence: number;
  reason: string;
}

/**
 * An import adapter turns one planning software's export into a Canonical Case.
 * Vendor adapters are written only from real sample exports (see docs/adapters.md).
 */
export interface ImportAdapter {
  readonly name: string;
  readonly version: string;
  /** vendor recorded on the case ("generic" for the fallback) */
  readonly vendor: string;
  detect(ctx: ImportContext): Detection;
  import(ctx: ImportContext): ImportResult;
}
