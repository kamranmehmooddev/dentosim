# Canonical Case

The Canonical Case is the single internal representation of a treatment plan. Every
import adapter — generic, saved mapping template, manual mapping, and each vendor
adapter — produces exactly this structure; everything after import (normalisation,
segmentation, registration, packaging, the viewer) consumes only this.

* TypeScript types: [`packages/canonical/src/types.ts`](../packages/canonical/src/types.ts)
* JSON Schema (draft 2020-12, serialised form): [`packages/canonical/schema/canonical-case.schema.json`](../packages/canonical/schema/canonical-case.schema.json)
* Validator: `validateCanonicalManifest()` from `@dentosim/canonical`
* Frame and units: [coordinate-system.md](coordinate-system.md) — millimetres, `dentosim-v1`

## Shape

```
CanonicalCase
├── schemaVersion "1.0", units "mm", coordinateSystem "dentosim-v1"
├── arches
│   ├── upper?  { jaw, stages[] }
│   └── lower?  { jaw, stages[] }          ← one arch may have fewer stages (finished earlier)
│         stage { index 0…N (continuous), sourceLabel, sourceFiles[], segmented, parts[] }
│           part { id (stable across stages), kind tooth|gums|attachment|base|arch,
│                  fdi?, fdiEstimated?, procedural?, mesh }
├── scans?          { upper?, lower?, bite? }      patient scans, in the case frame
├── toothMovements? [{ jaw, toothId, fdi, stage, translation (mm), rotation (°),
│                      mesial-distal / bucco-lingual / extrusion-intrusion, tip / torque / rotation }]
├── source          { vendor, adapter {name, version}, detection[] (every detector's score),
│                     mappingApplied?, fileMap[] (every file: role, jaw, stage, sha256, reason) }
├── normalization?  { sourceUnits, scaleApplied, transforms per jaw, interArch, tiltCorrectedDeg }
├── segmentation?   { performed, per jaw: teeth, attachments, droppedFragments, fusedSplit,
│                     unsegmented, proceduralGums }
├── registration?   { performed, method, scansPresent, upper/lower fit (matrix, trimmed mean,
│                     median, rms), biteConsistencyMedianMm, note }
└── warnings[]      { code, severity info|warning|error, message (human-readable, no PHI), file?, jaw?, stage? }
```

`mesh` is in-memory `{ positions: Float32Array, indices: Uint32Array }` inside the
pipeline and `{ uri, vertexCount, triangleCount }` in the serialised manifest
(`uri` = `upper/stage-03.tsm2#tooth-11`).

## Stage rules

* Stages are re-indexed continuously from 0; the original label is kept in
  `sourceLabel` (`"initial"`, `"03"`, `"final"`). Gaps produce `STAGE_GAP`.
* `initial` / `malocclusion` / `pre` / `start` sort before numbered stages; `final` after.
* A stage identical to the previous one (e.g. `final` duplicating the last number) is merged.
* No stage 0 → `NO_INITIAL_STAGE`; the first exported stage is shown as the start.
* Upper-only and lower-only cases are valid.

## Warning codes

| Code | Severity | Meaning |
|------|----------|---------|
| `UNITS_CONVERTED_INCH/CM/M` | info | models converted to mm |
| `UNITS_UNCERTAIN` | warning | arch size implausible after conversion |
| `SCAN_UNITS_CONVERTED` | info | a scan was converted to mm |
| `STAGE_GAP` | warning | stage numbers skipped; re-numbered |
| `NO_INITIAL_STAGE` | warning | no stage 0 / initial model |
| `DUPLICATE_STAGE` | info | identical consecutive stages merged |
| `DUPLICATE_FILE` | info | byte-identical copy ignored |
| `ARCH_FINISHES_EARLY` | info | one arch has fewer stages |
| `MULTIPLE_SCANS` | warning | several files for one scan, combined |
| `JAW_FROM_GEOMETRY` | warning | jaw inferred from shape (palate) |
| `FRAGMENTS_DROPPED` | info | tiny shells (embossed text) removed |
| `FUSED_TEETH_SPLIT` | warning | fused molars split at the waist |
| `UNSEGMENTED` | warning | teeth fused with gums; no per-tooth selection |
| `PROCEDURAL_GUMS` | info | teeth-only export; illustrative gums |
| `TOOTH_TRACKING` | info | a tooth could not be followed between stages |
| `FDI_ESTIMATED` | info | tooth numbers estimated from position |
| `REGISTRATION_POOR_FIT` | warning | plan vs scan trimmed mean > 0.3 mm |
| `BITE_SCAN_INCONSISTENT` | warning | bite scan disagrees with registered arches |
| `INTER_ARCH_RECONSTRUCTED` | warning | export had no usable bite; approximate occlusion |
| `ORIENTATION_CHECK` / `ORIENTATION_UNCERTAIN` | warning | orientation should be reviewed |
