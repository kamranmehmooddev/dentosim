# DentoSim

**Turn any clear-aligner treatment plan into a branded, interactive 3D patient experience.**
Import → Register → Review → Approve → Share.

DentoSim is a multi-tenant, white-label SaaS for clear-aligner companies, dental labs and
orthodontic groups. It does **not** plan treatment: it sits after any planning software
and is the presentation, registration, approval and delivery layer.

```
Upload ──► Process ──► Validate ──► Publish ──► View
(any export)  (pure pipeline)  (immutable package)   (Unity WebGL viewer, doctors + patients)
```

## Status by phase

| Phase | Scope | Status |
|---|---|---|
| 1 | Canonical Case schema + generic adapter + CLI + self-check | ✅ done |
| 2 | Segmentation, bite registration, TSM2 compression, packaging | ✅ done |
| 3 | Unity WebGL viewer | next |
| 4 | App core: auth, orgs, cases, upload → process → viewer, revisions, mapping screen | planned |
| 5 | Vendor adapters from real samples | waiting for sample exports |
| 6 | Sharing: doctors, patient links, comments, approvals, notifications | planned |
| 7 | Stripe billing, plan limits, branding, custom domains | planned |
| 8 | Hardening: audit log, retention, rate limits, load test | planned |

## Repository layout

```
packages/
  canonical/   Canonical Case — TypeScript types, JSON Schema, validator
  pipeline/    pure import + processing library, CLI, self-check, synthetic fixtures
fixtures/      self-check fixtures (expected.json per fixture)
docs/          coordinate system, Canonical Case, TSM2 format, adapters
```

## Quick start

Requirements: Node ≥ 22, pnpm 10.

```bash
pnpm install
pnpm --filter @dentosim/canonical build      # the pipeline imports the built types
pnpm test                                    # unit tests + every fixture through the self-check
```

### CLI

```bash
cd packages/pipeline
pnpm cli <export> <outDir> [--adapter name] [--template t.json]... [--mapping m.json] [--overwrite] [--json]
pnpm cli detect <export>             # detection scores + proposed file mapping
pnpm cli inspect <packageDir>        # summary + decode/CRC-check every TSM2 file
pnpm cli template <mapping.json> --id acme --name "Acme export" --out acme.json
pnpm selfcheck                       # run all fixtures (same code path as the worker)
pnpm fixtures                        # (re)generate synthetic fixture exports
pnpm bench [dir] [--stages 20]       # ~300 MB dense export, end to end
```

`<export>` can be a folder, a `.zip` (nested zips and duplicate files are fine),
`.7z`/`.rar` when 7-Zip is installed on the machine, or a single model file.
Exit codes: `0` ready, `3` needs mapping, `4` failed with a user-facing reason.

Example:

```
$ pnpm cli ../../fixtures/generic-maxmand-folders/export.zip /tmp/case-10482
Ready: /tmp/case-10482
  adapter      generic@1.0.0 (scores: generic 0.60)
  stages       upper 9, lower 7
  units        mm (×1); bite: export
  upper        14 teeth, 6 attachments
  lower        14 teeth, 6 attachments
  registration No patient scans were provided, so the bite shown is the relationship stored in the export itself.
  compression  3.78 MB → 0.44 MB (8.51×), error 0.00076 mm
```

## The processing pipeline

`processExport(input, outDir, options)` in `packages/pipeline/src/pipeline.ts` — a pure,
deterministic function used identically by the CLI, the tests/self-check and the worker.

1. **Intake / validate** — folder, zip (nested), loose files; file-count and size limits,
   zip-slip and zip-bomb protection, OS junk dropped; every mesh must parse.
2. **Import** — all detectors run; best adapter ≥ 0.3 (and ≥ 0.1 ahead of the runner-up)
   imports into the Canonical Case; otherwise the mapping screen gets a proposal.
   Saved per-organisation mapping templates are adapters too. See [docs/adapters.md](docs/adapters.md).
3. **Normalise** — units (inch/cm/m → mm), continuous stages 0…N, one arch may finish early,
   single-arch cases.
4. **Segment** — mesh connectivity: largest shell = gums/base, tooth-sized shells = teeth,
   small = attachments, tiny = embossed text (dropped); fused last molars split at the waist;
   single shell → `unsegmented`; teeth-only → illustrative procedural gums. Teeth keep the same
   id in every stage.
5. **Register** (patient scans only) — PCA multi-start + trimmed ICP (worst 25 % ignored,
   point-to-plane refinement), rigid only; applied to every stage. Trimmed mean + median fit
   error stored and shown. Without scans the export's own bite is used, and the UI says so.
6. **Orient** — level occlusal plane, upper above lower, incisors forward, undo print tilts;
   exports without a usable bite are placed in approximate occlusion and flagged.
   Frame: [docs/coordinate-system.md](docs/coordinate-system.md).
7. **Teeth** — FDI numbers (estimated from position when not in the export) and cumulative
   per-tooth movement (mm, °) for every stage.
8. **Package** — [TSM2](docs/tsm2.md) per arch per stage (weld → simplify ≤ 0.03 mm →
   16-bit quantisation → meshopt codecs), thumbnails, `metadata.json` (schema-validated
   Canonical Case with mesh references, compression stats, disclaimer, SHA-256 of every
   file) and `registration.json`. Written atomically; packages are immutable.

```
<package>/
├── metadata.json
├── registration.json
├── upper/stage-00.tsm2 …
├── lower/stage-00.tsm2 …
├── scans/upper.tsm2 …         (when scans were supplied)
└── thumbnails/*.png
```

## Test results (Phases 1–2)

* `pnpm test` → **75 tests passing** (3 schema + 72 pipeline): loaders (all formats), upload hardening
  (zip-slip, zip-bomb, limits, nesting), filename inference, detection scoring/ambiguity,
  templates, units, jaw-from-geometry, segmentation (teeth/attachments/text/fused molar/
  single shell), registration (large transforms, sub-0.1 mm fit, never mirrors),
  TSM2 round-trip/corruption, end-to-end orientation, bite restoration from scans,
  immutable schema-valid packages, and all 10 fixtures (13 runs).
* Registration on the scan fixture: trimmed mean **0.028 mm / 0.027 mm** (upper/lower);
  the true bite is restored to within 0.1 mm.
* Load benchmark (`pnpm bench`): **293 MB** binary STL (42 files, 5.8 M triangles) →
  **5.9 MB** package in **23 s** on 4 vCPUs; **57×** smaller; compression error
  trimmed mean **0.007 mm**, max 0.07 mm; peak RSS 0.86 GB.

## Documentation

* [docs/coordinate-system.md](docs/coordinate-system.md) — the DentoSim frame
* [docs/canonical-case.md](docs/canonical-case.md) — Canonical Case, stage rules, warning codes
* [docs/tsm2.md](docs/tsm2.md) — TSM2 binary format
* [docs/adapters.md](docs/adapters.md) — adapter contract, detection, generic inference,
  templates, vendor adapter process, out-of-scope proprietary formats
* [fixtures/README.md](fixtures/README.md) — fixtures and `expected.json`

## Out of scope

Automatic treatment planning, AI tooth segmentation, contact analysis, IPR editing,
recorded jaw motion, proprietary/encrypted formats that need a vendor SDK or licence
(see [docs/adapters.md](docs/adapters.md#out-of-scope-proprietary--encrypted-formats)),
native mobile apps.
